import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { Escrow } from "../target/types/escrow";

// `anchor test` sets ANCHOR_PROVIDER_URL and ANCHOR_WALLET from Anchor.toml.
// The wallet there is the bot-resolver keypair — which we treat as both
// payer and (for these tests) admin + resolver.

const CONFIG_SEED = Buffer.from("config");
const BET_SEED = Buffer.from("bet");
const VAULT_SEED = Buffer.from("vault");

function betIdBuf(id: BN): Buffer {
  return id.toArrayLike(Buffer, "le", 8);
}

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const resolver = admin; // same identity for tests
  const treasury = Keypair.generate();

  let mint: PublicKey;
  const challenger = Keypair.generate();
  const accepter = Keypair.generate();

  const AMOUNT = new BN(50_000_000); // 50 tokens at 6 decimals
  const FEE_BPS = 250;

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    program.programId,
  );

  before(async () => {
    // airdrop lamports to participants for rent + signing
    for (const kp of [challenger, accepter, treasury]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // create mockUSDC mint, 6 decimals
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
    );

    // mint 1000 tokens each to challenger + accepter
    for (const user of [challenger, accepter]) {
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        user.publicKey,
      );
      await mintTo(
        provider.connection,
        admin,
        mint,
        ata.address,
        admin,
        1_000_000_000, // 1000 tokens
      );
    }

    // ensure treasury ATA exists
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      treasury.publicKey,
    );
  });

  it("initializes config (idempotent)", async () => {
    const existing = await program.account.config.fetchNullable(configPda);
    if (existing) {
      // rotate treasury/resolver to our test keys
      await program.methods
        .updateConfig(FEE_BPS, treasury.publicKey, resolver.publicKey)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();
    } else {
      await program.methods
        .initializeConfig(FEE_BPS, treasury.publicKey, resolver.publicKey)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.feeBps, FEE_BPS);
    assert.ok(config.treasury.equals(treasury.publicKey));
    assert.ok(config.resolver.equals(resolver.publicKey));
  });

  async function createBet(betId: BN, amount: BN) {
    const [betPda] = PublicKey.findProgramAddressSync(
      [BET_SEED, betIdBuf(betId)],
      program.programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, betIdBuf(betId)],
      program.programId,
    );
    await program.methods
      .initializeBet(betId, amount, challenger.publicKey, accepter.publicKey)
      .accountsPartial({
        bet: betPda,
        vault: vaultPda,
        mint,
        payer: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return { betPda, vaultPda };
  }

  async function deposit(
    betId: BN,
    betPda: PublicKey,
    vaultPda: PublicKey,
    user: Keypair,
  ) {
    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      user.publicKey,
    );
    await program.methods
      .deposit(betId)
      .accountsPartial({
        bet: betPda,
        vault: vaultPda,
        depositorAta: userAta.address,
        depositor: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
  }

  it("runs happy path: init → both deposit → resolve → winner + treasury paid", async () => {
    const betId = new BN(Date.now());
    const { betPda, vaultPda } = await createBet(betId, AMOUNT);
    await deposit(betId, betPda, vaultPda, challenger);
    await deposit(betId, betPda, vaultPda, accepter);

    let bet = await program.account.bet.fetch(betPda);
    assert.deepEqual(bet.status, { funded: {} });

    const winnerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        challenger.publicKey,
      )
    ).address;
    const treasuryAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury.publicKey,
      )
    ).address;

    const winnerBefore = (await getAccount(provider.connection, winnerAta))
      .amount;
    const treasuryBefore = (await getAccount(provider.connection, treasuryAta))
      .amount;

    await program.methods
      .resolve(betId, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        winnerAta,
        treasuryAta,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const winnerAfter = (await getAccount(provider.connection, winnerAta))
      .amount;
    const treasuryAfter = (await getAccount(provider.connection, treasuryAta))
      .amount;

    const total = BigInt(AMOUNT.toString()) * 2n;
    const fee = (total * BigInt(FEE_BPS)) / 10_000n;
    const payout = total - fee;

    assert.equal(winnerAfter - winnerBefore, payout);
    assert.equal(treasuryAfter - treasuryBefore, fee);

    bet = await program.account.bet.fetch(betPda);
    assert.deepEqual(bet.status, { resolved: {} });
    assert.ok(bet.winner.equals(challenger.publicKey));
  });

  it("refunds both sides on cancel", async () => {
    const betId = new BN(Date.now() + 1);
    const { betPda, vaultPda } = await createBet(betId, AMOUNT);
    await deposit(betId, betPda, vaultPda, challenger);
    await deposit(betId, betPda, vaultPda, accepter);

    const challengerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        challenger.publicKey,
      )
    ).address;
    const accepterAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        accepter.publicKey,
      )
    ).address;

    const cBefore = (await getAccount(provider.connection, challengerAta))
      .amount;
    const aBefore = (await getAccount(provider.connection, accepterAta))
      .amount;

    await program.methods
      .refund(betId)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        challengerAta,
        accepterAta,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const cAfter = (await getAccount(provider.connection, challengerAta))
      .amount;
    const aAfter = (await getAccount(provider.connection, accepterAta)).amount;

    assert.equal(cAfter - cBefore, BigInt(AMOUNT.toString()));
    assert.equal(aAfter - aBefore, BigInt(AMOUNT.toString()));

    const bet = await program.account.bet.fetch(betPda);
    assert.deepEqual(bet.status, { refunded: {} });
  });

  it("rejects double-deposit from the same participant", async () => {
    const betId = new BN(Date.now() + 2);
    const { betPda, vaultPda } = await createBet(betId, AMOUNT);
    await deposit(betId, betPda, vaultPda, challenger);
    try {
      await deposit(betId, betPda, vaultPda, challenger);
      assert.fail("should have thrown AlreadyDeposited");
    } catch (e: any) {
      assert.include(e.toString(), "AlreadyDeposited");
    }
  });

  it("rejects resolve signed by non-resolver", async () => {
    const betId = new BN(Date.now() + 3);
    const { betPda, vaultPda } = await createBet(betId, AMOUNT);
    await deposit(betId, betPda, vaultPda, challenger);
    await deposit(betId, betPda, vaultPda, accepter);

    const imposter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      imposter.publicKey,
      1 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    const winnerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        challenger.publicKey,
      )
    ).address;
    const treasuryAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury.publicKey,
      )
    ).address;

    try {
      await program.methods
        .resolve(betId, challenger.publicKey)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          vault: vaultPda,
          winnerAta,
          treasuryAta,
          resolver: imposter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([imposter])
        .rpc();
      assert.fail("should have thrown UnauthorizedResolver");
    } catch (e: any) {
      assert.include(e.toString(), "UnauthorizedResolver");
    }
  });
});
