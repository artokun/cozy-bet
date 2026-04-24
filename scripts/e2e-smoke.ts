/**
 * End-to-end smoke test against a running Solana validator.
 *
 * Exercises every instruction in the escrow program and verifies token
 * balances on-chain. No Discord/DB involvement — this is pure on-chain
 * validation.
 *
 *   RPC=http://127.0.0.1:8899 pnpm tsx scripts/e2e-smoke.ts
 */
import {
  AnchorProvider,
  Program,
  Wallet,
  BN,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const DECIMALS = 6;
const FEE_BPS = 250;
const STAKE = new BN(50 * 10 ** DECIMALS); // 50 mUSDC

const programId = new PublicKey("nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt");
const resolverRaw = JSON.parse(
  fs.readFileSync("./keys/bot-resolver.json", "utf8"),
);
const treasuryRaw = JSON.parse(fs.readFileSync("./keys/treasury.json", "utf8"));
const resolver = Keypair.fromSecretKey(Uint8Array.from(resolverRaw));
const treasury = Keypair.fromSecretKey(Uint8Array.from(treasuryRaw));

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(resolver), {
  preflightCommitment: "confirmed",
});
const program = new Program<Escrow>(idl as Idl as Escrow, provider);

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

function pda(seed: string, ...extras: Buffer[]) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...extras],
    programId,
  )[0];
}

function betIdBuf(id: BN) {
  return id.toArrayLike(Buffer, "le", 8);
}

async function main() {
  console.log("== cozy-bet e2e smoke ==");
  console.log("rpc:", RPC);
  console.log("program:", programId.toBase58());

  // ---------------------------------------------------------------
  // Bootstrap: create mockUSDC mint + two test users with 1000 mUSDC each
  // ---------------------------------------------------------------
  const challenger = Keypair.generate();
  const accepter = Keypair.generate();
  await airdrop(challenger.publicKey, 2);
  await airdrop(accepter.publicKey, 2);

  const mint = await createMint(
    connection,
    resolver,
    resolver.publicKey,
    null,
    DECIMALS,
  );
  console.log("mint:", mint.toBase58());

  for (const u of [challenger, accepter]) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      resolver,
      mint,
      u.publicKey,
    );
    await mintTo(connection, resolver, mint, ata.address, resolver, 1000 * 10 ** DECIMALS);
  }
  await getOrCreateAssociatedTokenAccount(
    connection,
    resolver,
    mint,
    treasury.publicKey,
  );

  // ---------------------------------------------------------------
  // initialize_config (idempotent)
  // ---------------------------------------------------------------
  const configPda = pda("config");
  const existing = await program.account.config.fetchNullable(configPda);
  if (!existing) {
    await program.methods
      .initializeConfig(FEE_BPS, treasury.publicKey, resolver.publicKey)
      .accountsPartial({ config: configPda, authority: resolver.publicKey })
      .rpc();
    console.log("initialized config");
  } else {
    await program.methods
      .updateConfig(FEE_BPS, treasury.publicKey, resolver.publicKey)
      .accountsPartial({ config: configPda, authority: resolver.publicKey })
      .rpc();
    console.log("updated config");
  }

  // ---------------------------------------------------------------
  // Scenario A: happy path (init → deposit × 2 → resolve → verify)
  // ---------------------------------------------------------------
  console.log("\n-- scenario A: happy path --");
  const betIdA = new BN(Date.now());
  const betPdaA = pda("bet", betIdBuf(betIdA));
  const vaultPdaA = pda("vault", betIdBuf(betIdA));

  await program.methods
    .initializeBet(betIdA, STAKE, challenger.publicKey, accepter.publicKey)
    .accountsPartial({
      bet: betPdaA,
      vault: vaultPdaA,
      mint,
      payer: resolver.publicKey,
    })
    .rpc();
  console.log("  init bet", betIdA.toString());

  async function deposit(user: Keypair, betId: BN, betPda: PublicKey, vaultPda: PublicKey) {
    const ata = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        resolver,
        mint,
        user.publicKey,
      )
    ).address;
    await program.methods
      .deposit(betId)
      .accountsPartial({
        bet: betPda,
        vault: vaultPda,
        depositorAta: ata,
        depositor: user.publicKey,
      })
      .signers([user])
      .rpc();
  }
  await deposit(challenger, betIdA, betPdaA, vaultPdaA);
  await deposit(accepter, betIdA, betPdaA, vaultPdaA);
  console.log("  both deposited");

  const betRowA = await program.account.bet.fetch(betPdaA);
  if (!("funded" in betRowA.status)) throw new Error("expected funded");

  const winnerAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, challenger.publicKey)
  ).address;
  const treasuryAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, treasury.publicKey)
  ).address;
  const winnerBefore = (await getAccount(connection, winnerAta)).amount;
  const treasuryBefore = (await getAccount(connection, treasuryAta)).amount;

  await program.methods
    .resolve(betIdA, challenger.publicKey)
    .accountsPartial({
      config: configPda,
      bet: betPdaA,
      vault: vaultPdaA,
      winnerAta,
      treasuryAta,
      resolver: resolver.publicKey,
    })
    .rpc();

  const winnerAfter = (await getAccount(connection, winnerAta)).amount;
  const treasuryAfter = (await getAccount(connection, treasuryAta)).amount;
  const total = BigInt(STAKE.toString()) * 2n;
  const expectedFee = (total * BigInt(FEE_BPS)) / 10_000n;
  const expectedPayout = total - expectedFee;
  const gotPayout = winnerAfter - winnerBefore;
  const gotFee = treasuryAfter - treasuryBefore;
  console.log(
    `  winner received ${gotPayout} (expected ${expectedPayout}), treasury received ${gotFee} (expected ${expectedFee})`,
  );
  if (gotPayout !== expectedPayout) throw new Error("winner payout mismatch");
  if (gotFee !== expectedFee) throw new Error("treasury fee mismatch");

  // ---------------------------------------------------------------
  // Scenario B: refund (init → deposit × 2 → refund → verify)
  // ---------------------------------------------------------------
  console.log("\n-- scenario B: refund --");
  const betIdB = new BN(Date.now() + 1);
  const betPdaB = pda("bet", betIdBuf(betIdB));
  const vaultPdaB = pda("vault", betIdBuf(betIdB));
  await program.methods
    .initializeBet(betIdB, STAKE, challenger.publicKey, accepter.publicKey)
    .accountsPartial({ bet: betPdaB, vault: vaultPdaB, mint, payer: resolver.publicKey })
    .rpc();
  await deposit(challenger, betIdB, betPdaB, vaultPdaB);
  await deposit(accepter, betIdB, betPdaB, vaultPdaB);

  const cAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, challenger.publicKey)
  ).address;
  const aAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, accepter.publicKey)
  ).address;
  const cB = (await getAccount(connection, cAta)).amount;
  const aB = (await getAccount(connection, aAta)).amount;

  await program.methods
    .refund(betIdB)
    .accountsPartial({
      config: configPda,
      bet: betPdaB,
      vault: vaultPdaB,
      challengerAta: cAta,
      accepterAta: aAta,
      resolver: resolver.publicKey,
    })
    .rpc();

  const cA = (await getAccount(connection, cAta)).amount;
  const aA = (await getAccount(connection, aAta)).amount;
  console.log(`  challenger got back ${cA - cB}, accepter got back ${aA - aB}`);
  if (cA - cB !== BigInt(STAKE.toString()))
    throw new Error("challenger refund mismatch");
  if (aA - aB !== BigInt(STAKE.toString()))
    throw new Error("accepter refund mismatch");

  // ---------------------------------------------------------------
  // Scenario C: double-deposit rejected
  // ---------------------------------------------------------------
  console.log("\n-- scenario C: reject double-deposit --");
  const betIdC = new BN(Date.now() + 2);
  const betPdaC = pda("bet", betIdBuf(betIdC));
  const vaultPdaC = pda("vault", betIdBuf(betIdC));
  await program.methods
    .initializeBet(betIdC, STAKE, challenger.publicKey, accepter.publicKey)
    .accountsPartial({ bet: betPdaC, vault: vaultPdaC, mint, payer: resolver.publicKey })
    .rpc();
  await deposit(challenger, betIdC, betPdaC, vaultPdaC);
  try {
    await deposit(challenger, betIdC, betPdaC, vaultPdaC);
    throw new Error("second deposit should have failed");
  } catch (e: any) {
    if (!String(e).includes("AlreadyDeposited")) throw e;
    console.log("  correctly rejected double-deposit");
  }

  // ---------------------------------------------------------------
  // Scenario D: unauthorized resolve rejected
  // ---------------------------------------------------------------
  console.log("\n-- scenario D: reject unauthorized resolver --");
  const betIdD = new BN(Date.now() + 3);
  const betPdaD = pda("bet", betIdBuf(betIdD));
  const vaultPdaD = pda("vault", betIdBuf(betIdD));
  await program.methods
    .initializeBet(betIdD, STAKE, challenger.publicKey, accepter.publicKey)
    .accountsPartial({ bet: betPdaD, vault: vaultPdaD, mint, payer: resolver.publicKey })
    .rpc();
  await deposit(challenger, betIdD, betPdaD, vaultPdaD);
  await deposit(accepter, betIdD, betPdaD, vaultPdaD);

  const imposter = Keypair.generate();
  await airdrop(imposter.publicKey, 1);
  try {
    await program.methods
      .resolve(betIdD, challenger.publicKey)
      .accountsPartial({
        config: configPda,
        bet: betPdaD,
        vault: vaultPdaD,
        winnerAta,
        treasuryAta,
        resolver: imposter.publicKey,
      })
      .signers([imposter])
      .rpc();
    throw new Error("imposter resolve should have failed");
  } catch (e: any) {
    if (!String(e).includes("UnauthorizedResolver")) throw e;
    console.log("  correctly rejected imposter resolve");
  }

  // Clean up the orphan bet D with a refund so nothing is left on-chain.
  await program.methods
    .refund(betIdD)
    .accountsPartial({
      config: configPda,
      bet: betPdaD,
      vault: vaultPdaD,
      challengerAta: cAta,
      accepterAta: aAta,
      resolver: resolver.publicKey,
    })
    .rpc();

  console.log("\n✅ all scenarios passed");
}

main().catch((e) => {
  console.error("\n❌ e2e failed:", e);
  process.exit(1);
});
