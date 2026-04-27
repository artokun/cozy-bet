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
// The wallet at Anchor.toml is the bot-resolver keypair — admin + resolver +
// arbiter for these tests. Treasury owners are 4 fresh keypairs per run.

const CONFIG_SEED = Buffer.from("config");
const BET_SEED = Buffer.from("bet");
const VAULT_SEED = Buffer.from("vault");

const DEFAULT_FEE_BPS = 250;
const MIN_DISCOUNTED_FEE_BPS = 150;
const ARBITER_MIN_FEE = new BN(100_000_000); // $100 at 6 decimals
const ARBITER_FEE_BPS_OF_POT = 100; // 1%

function betIdBuf(id: BN): Buffer {
  return id.toArrayLike(Buffer, "le", 8);
}

const ZERO_TERMS_HASH: number[] = Array(32).fill(0);
function hashFor(s: string): number[] {
  // simplistic: pad/truncate string bytes to 32. Tests only need a non-zero,
  // deterministic value for storage assertions.
  const buf = Buffer.alloc(32);
  Buffer.from(s).copy(buf, 0, 0, Math.min(32, Buffer.from(s).length));
  return Array.from(buf);
}

describe("escrow v2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const resolver = admin;
  const arbiter = admin; // same identity (multi-role) for these tests
  const treasury0 = Keypair.generate();
  const treasury1 = Keypair.generate();
  const treasury2 = Keypair.generate();
  const treasury3 = Keypair.generate();

  let mint: PublicKey;
  const challenger = Keypair.generate();
  const accepter = Keypair.generate();

  const AMOUNT = new BN(50_000_000); // 50 mUSDC

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    program.programId,
  );

  let treasuryAta0: PublicKey;
  let treasuryAta1: PublicKey;
  let treasuryAta2: PublicKey;
  let treasuryAta3: PublicKey;
  let challengerAta: PublicKey;
  let accepterAta: PublicKey;

  before(async () => {
    for (const kp of [
      challenger,
      accepter,
      treasury0,
      treasury1,
      treasury2,
      treasury3,
    ]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
    );

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
        10_000_000_000, // 10,000 tokens
      );
    }

    challengerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        challenger.publicKey,
      )
    ).address;
    accepterAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        accepter.publicKey,
      )
    ).address;
    treasuryAta0 = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury0.publicKey,
      )
    ).address;
    treasuryAta1 = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury1.publicKey,
      )
    ).address;
    treasuryAta2 = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury2.publicKey,
      )
    ).address;
    treasuryAta3 = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        treasury3.publicKey,
      )
    ).address;
  });

  it("initializes config (idempotent)", async () => {
    const owners: [PublicKey, PublicKey, PublicKey, PublicKey] = [
      treasury0.publicKey,
      treasury1.publicKey,
      treasury2.publicKey,
      treasury3.publicKey,
    ];
    const existing = await program.account.config.fetchNullable(configPda);
    if (existing) {
      await program.methods
        .updateConfig(
          owners,
          resolver.publicKey,
          arbiter.publicKey,
          DEFAULT_FEE_BPS,
          MIN_DISCOUNTED_FEE_BPS,
          ARBITER_MIN_FEE,
          ARBITER_FEE_BPS_OF_POT,
        )
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();
    } else {
      await program.methods
        .initializeConfig(
          owners,
          resolver.publicKey,
          arbiter.publicKey,
          DEFAULT_FEE_BPS,
          MIN_DISCOUNTED_FEE_BPS,
          ARBITER_MIN_FEE,
          ARBITER_FEE_BPS_OF_POT,
        )
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.defaultFeeBps, DEFAULT_FEE_BPS);
    assert.equal(config.minDiscountedFeeBps, MIN_DISCOUNTED_FEE_BPS);
    assert.equal(config.arbiterFeeBpsOfPot, ARBITER_FEE_BPS_OF_POT);
    assert.ok(config.arbiterMinFee.eq(ARBITER_MIN_FEE));
    assert.ok(config.treasuryOwners[0].equals(treasury0.publicKey));
    assert.ok(config.treasuryOwners[3].equals(treasury3.publicKey));
    assert.ok(config.resolver.equals(resolver.publicKey));
    assert.ok(config.arbiter.equals(arbiter.publicKey));
  });

  function pdas(betId: BN) {
    const [betPda] = PublicKey.findProgramAddressSync(
      [BET_SEED, betIdBuf(betId)],
      program.programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, betIdBuf(betId)],
      program.programId,
    );
    return { betPda, vaultPda };
  }

  async function createBet(
    betId: BN,
    amount: BN,
    termsHash: number[] = ZERO_TERMS_HASH,
  ) {
    const { betPda, vaultPda } = pdas(betId);
    await program.methods
      .initializeBet(
        betId,
        amount,
        challenger.publicKey,
        accepter.publicKey,
        termsHash,
      )
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        mint,
        resolver: resolver.publicKey,
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
    const ata =
      user.publicKey.equals(challenger.publicKey) ? challengerAta : accepterAta;
    await program.methods
      .deposit(betId)
      .accountsPartial({
        bet: betPda,
        vault: vaultPda,
        depositorAta: ata,
        depositor: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
  }

  async function fundBet(betId: BN, amount: BN, termsHash?: number[]) {
    const { betPda, vaultPda } = await createBet(betId, amount, termsHash);
    await deposit(betId, betPda, vaultPda, challenger);
    await deposit(betId, betPda, vaultPda, accepter);
    return { betPda, vaultPda };
  }

  it("happy path: resolve splits fee 4 ways + winner gets remainder", async () => {
    const betId = new BN(Date.now());
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);

    const winnerBefore = (
      await getAccount(provider.connection, challengerAta)
    ).amount;
    const t0Before = (await getAccount(provider.connection, treasuryAta0))
      .amount;

    await program.methods
      .resolve(betId, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        winnerAta: challengerAta,
        treasuryAta0,
        treasuryAta1,
        treasuryAta2,
        treasuryAta3,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // fee = stake*c_bps + stake*a_bps / 10000 = AMOUNT * (250 + 250) / 10000
    const total = BigInt(AMOUNT.toString()) * 2n;
    const fee =
      (BigInt(AMOUNT.toString()) * BigInt(DEFAULT_FEE_BPS * 2)) / 10_000n;
    const perOwner = fee / 4n;
    const payout = total - fee;

    const winnerAfter = (await getAccount(provider.connection, challengerAta))
      .amount;
    const t0After = (await getAccount(provider.connection, treasuryAta0))
      .amount;
    const t1After = (await getAccount(provider.connection, treasuryAta1))
      .amount;
    const t2After = (await getAccount(provider.connection, treasuryAta2))
      .amount;
    const t3After = (await getAccount(provider.connection, treasuryAta3))
      .amount;

    assert.equal(winnerAfter - winnerBefore, payout);
    // 50e6 * 2 = 100e6 pot; fee = 100e6 * 500 / 10000 = 5e6. /4 = 1.25e6 each.
    assert.equal(t0After - t0Before, perOwner); // remainder is 0 here
    assert.equal(t1After, perOwner);
    assert.equal(t2After, perOwner);
    assert.equal(t3After, perOwner);

    const bet = await program.account.bet.fetch(betPda);
    assert.deepEqual(bet.status, { resolved: {} });
  });

  it("draw refunds full stakes — no fee taken", async () => {
    const betId = new BN(Date.now() + 1);
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);
    const cBefore = (await getAccount(provider.connection, challengerAta))
      .amount;
    const aBefore = (await getAccount(provider.connection, accepterAta))
      .amount;
    const t0Before = (await getAccount(provider.connection, treasuryAta0))
      .amount;
    await program.methods
      .draw(betId)
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
    const t0After = (await getAccount(provider.connection, treasuryAta0))
      .amount;
    assert.equal(cAfter - cBefore, BigInt(AMOUNT.toString()));
    assert.equal(aAfter - aBefore, BigInt(AMOUNT.toString()));
    assert.equal(t0After, t0Before, "treasury should NOT receive fee on draw");
    const bet = await program.account.bet.fetch(betPda);
    assert.deepEqual(bet.status, { drawn: {} });
  });

  it("set_fee_bps_for_side reduces a side's fee, math reflected on resolve", async () => {
    const betId = new BN(Date.now() + 2);
    const { betPda } = await createBet(betId, AMOUNT);
    // reduce challenger from 250 to 150
    await program.methods
      .setFeeBpsForSide(betId, challenger.publicKey, 150)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        resolver: resolver.publicKey,
      })
      .rpc();
    // reduce again to 200 should fail (no-increase)
    try {
      await program.methods
        .setFeeBpsForSide(betId, challenger.publicKey, 200)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          resolver: resolver.publicKey,
        })
        .rpc();
      assert.fail("should have rejected fee bps increase");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidFeeBps");
    }
    // below floor (150) should fail
    try {
      await program.methods
        .setFeeBpsForSide(betId, challenger.publicKey, 100)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          resolver: resolver.publicKey,
        })
        .rpc();
      assert.fail("should have rejected below-floor bps");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidFeeBps");
    }
    const bet = await program.account.bet.fetch(betPda);
    assert.equal(bet.challengerFeeBps, 150);
    assert.equal(bet.accepterFeeBps, 250);

    // Fund + resolve, verify per-side math
    const { vaultPda } = pdas(betId);
    await deposit(betId, betPda, vaultPda, challenger);
    await deposit(betId, betPda, vaultPda, accepter);

    const cBefore = (await getAccount(provider.connection, challengerAta))
      .amount;
    await program.methods
      .resolve(betId, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        winnerAta: challengerAta,
        treasuryAta0,
        treasuryAta1,
        treasuryAta2,
        treasuryAta3,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const cAfter = (await getAccount(provider.connection, challengerAta))
      .amount;
    // fee = AMOUNT*150 + AMOUNT*250 / 10000 = AMOUNT*400/10000 = AMOUNT*4/100
    // payout = AMOUNT*2 - AMOUNT*4/100 = 100e6 - 2e6 = 98e6
    const expected = BigInt(AMOUNT.toString()) * 2n - (BigInt(AMOUNT.toString()) * 400n) / 10_000n;
    assert.equal(cAfter - cBefore, expected);
  });

  it("arbiter_resolve takes max(arbiter_min_fee, 1% pot) on small pot", async () => {
    const betId = new BN(Date.now() + 3);
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);
    // pot = 100 mUSDC. 1% = 1 mUSDC. min = 100 mUSDC. min wins.
    // so arbiter takes 100 mUSDC; standard fee = 5 mUSDC; pot - 100 - 5 = NEGATIVE.
    // Our 50e6 stake gives 100e6 pot, min arbiter fee is 100e6 → pot too small.
    try {
      await program.methods
        .arbiterResolve(betId, challenger.publicKey)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          vault: vaultPda,
          winnerAta: challengerAta,
          treasuryAta0,
          treasuryAta1,
          treasuryAta2,
          treasuryAta3,
          arbiterAta: challengerAta, // arbiter = admin = challenger? no, arbiter is admin
          arbiter: arbiter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected pot-too-small error");
    } catch (e: any) {
      assert.include(e.toString(), "PotTooSmallForArbiter");
    }
  });

  it("arbiter_resolve takes 1% on large pot", async () => {
    const stake = new BN(100_000_000_000); // 100,000 mUSDC each
    // first mint enough
    await mintTo(
      provider.connection,
      admin,
      mint,
      challengerAta,
      admin,
      Number(stake.toString()),
    );
    await mintTo(
      provider.connection,
      admin,
      mint,
      accepterAta,
      admin,
      Number(stake.toString()),
    );

    // Set up arbiter ATA — admin's own ATA receives the fee since arbiter==admin
    const arbiterAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        arbiter.publicKey,
      )
    ).address;

    const betId = new BN(Date.now() + 4);
    const { betPda, vaultPda } = await fundBet(betId, stake);

    const arbiterBefore = (await getAccount(provider.connection, arbiterAta))
      .amount;

    await program.methods
      .arbiterResolve(betId, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        winnerAta: challengerAta,
        treasuryAta0,
        treasuryAta1,
        treasuryAta2,
        treasuryAta3,
        arbiterAta,
        arbiter: arbiter.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const arbiterAfter = (await getAccount(provider.connection, arbiterAta))
      .amount;

    const pot = BigInt(stake.toString()) * 2n;
    const expectedArbiterFee = (pot * 100n) / 10_000n; // 1%
    assert.equal(arbiterAfter - arbiterBefore, expectedArbiterFee);
  });

  it("rejects unauthorized resolve", async () => {
    const betId = new BN(Date.now() + 5);
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);

    const imposter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      imposter.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    try {
      await program.methods
        .resolve(betId, challenger.publicKey)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          vault: vaultPda,
          winnerAta: challengerAta,
          treasuryAta0,
          treasuryAta1,
          treasuryAta2,
          treasuryAta3,
          resolver: imposter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([imposter])
        .rpc();
      assert.fail("should have rejected non-resolver");
    } catch (e: any) {
      assert.include(e.toString(), "UnauthorizedResolver");
    }
  });

  it("terms_hash is stored + survives resolution", async () => {
    const betId = new BN(Date.now() + 6);
    const hash = hashFor("Resolves YES if LAL beats HOU 2026-04-24");
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT, hash);
    const before = await program.account.bet.fetch(betPda);
    assert.deepEqual(Array.from(before.termsHash as Uint8Array), hash);
    await program.methods
      .resolve(betId, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPda,
        vault: vaultPda,
        winnerAta: challengerAta,
        treasuryAta0,
        treasuryAta1,
        treasuryAta2,
        treasuryAta3,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const after = await program.account.bet.fetch(betPda);
    assert.deepEqual(Array.from(after.termsHash as Uint8Array), hash);
    assert.deepEqual(after.status, { resolved: {} });
  });

  it("rejects double-deposit", async () => {
    const betId = new BN(Date.now() + 7);
    const { betPda, vaultPda } = await createBet(betId, AMOUNT);
    await deposit(betId, betPda, vaultPda, challenger);
    try {
      await deposit(betId, betPda, vaultPda, challenger);
      assert.fail("should have thrown AlreadyDeposited");
    } catch (e: any) {
      assert.include(e.toString(), "AlreadyDeposited");
    }
  });

  it("refund + draw reject ATAs not owned by participants", async () => {
    // Funded bet
    const betId = new BN(Date.now() + 90);
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);

    // Imposter ATA — same mint, different owner
    const imposter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      imposter.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
    const imposterAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        imposter.publicKey,
      )
    ).address;

    // refund with imposter ATA in challenger slot — must reject
    try {
      await program.methods
        .refund(betId)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          vault: vaultPda,
          challengerAta: imposterAta,
          accepterAta,
          resolver: resolver.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("refund should have rejected non-challenger ATA");
    } catch (e: any) {
      assert.include(e.toString(), "AtaMismatch");
    }
    // draw with imposter ATA in accepter slot — must reject
    try {
      await program.methods
        .draw(betId)
        .accountsPartial({
          config: configPda,
          bet: betPda,
          vault: vaultPda,
          challengerAta,
          accepterAta: imposterAta,
          resolver: resolver.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("draw should have rejected non-accepter ATA");
    } catch (e: any) {
      assert.include(e.toString(), "AtaMismatch");
    }
  });

  it("refund returns deposits — both-sided + after one-sided", async () => {
    // both-sided refund
    const betId = new BN(Date.now() + 8);
    const { betPda, vaultPda } = await fundBet(betId, AMOUNT);
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

    // one-sided refund
    const betId2 = new BN(Date.now() + 9);
    const r2 = await createBet(betId2, AMOUNT);
    await deposit(betId2, r2.betPda, r2.vaultPda, challenger);
    const c2Before = (await getAccount(provider.connection, challengerAta))
      .amount;
    await program.methods
      .refund(betId2)
      .accountsPartial({
        config: configPda,
        bet: r2.betPda,
        vault: r2.vaultPda,
        challengerAta,
        accepterAta,
        resolver: resolver.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const c2After = (await getAccount(provider.connection, challengerAta))
      .amount;
    assert.equal(c2After - c2Before, BigInt(AMOUNT.toString()));
  });

  it("update_authority rotates admin and rejects stale signers", async () => {
    // Phase 1: rotate admin → fresh keypair, then verify update_config from
    // the OLD admin fails (UnauthorizedAdmin), and from the NEW admin succeeds.
    const newAdmin = anchor.web3.Keypair.generate();
    // Fund newAdmin minimally so it can pay rent for any subsequent calls.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        newAdmin.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      ),
      "confirmed",
    );

    await program.methods
      .updateAuthority(newAdmin.publicKey)
      .accountsPartial({
        config: configPda,
        authority: admin.publicKey,
      })
      .rpc();

    const cfg1 = await program.account.config.fetch(configPda);
    assert.equal(cfg1.authority.toBase58(), newAdmin.publicKey.toBase58());

    // OLD admin can no longer call update_config.
    let oldRejected = false;
    try {
      await program.methods
        .updateConfig(null, null, null, DEFAULT_FEE_BPS, null, null, null)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();
    } catch (e: any) {
      oldRejected = String(e).includes("UnauthorizedAdmin");
    }
    assert.ok(oldRejected, "old admin should be locked out after rotation");

    // NEW admin can call update_config.
    await program.methods
      .updateConfig(null, null, null, DEFAULT_FEE_BPS, null, null, null)
      .accountsPartial({
        config: configPda,
        authority: newAdmin.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    // Phase 2: rotate back to the original admin so the rest of the suite
    // (and re-runs) keep working.
    await program.methods
      .updateAuthority(admin.publicKey)
      .accountsPartial({
        config: configPda,
        authority: newAdmin.publicKey,
      })
      .signers([newAdmin])
      .rpc();
    const cfg2 = await program.account.config.fetch(configPda);
    assert.equal(cfg2.authority.toBase58(), admin.publicKey.toBase58());

    // Phase 3: zero-pubkey is rejected.
    let zeroRejected = false;
    try {
      await program.methods
        .updateAuthority(anchor.web3.PublicKey.default)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();
    } catch (e: any) {
      zeroRejected = String(e).includes("ZeroAddress");
    }
    assert.ok(zeroRejected, "zero pubkey should be rejected");
  });
});
