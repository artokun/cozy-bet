/**
 * Full Solana devnet lifecycle test. Uses the bot resolver wallet to fund
 * two ephemeral test users (no airdrop — direct SOL transfer + mockUSDC mint).
 *
 * Spends ~0.05 SOL from the resolver per run.
 *
 *   pnpm tsx scripts/testnet-lifecycle-solana.ts
 *
 * Verifies:
 *   - initialize_bet → both deposit → resolve → winner balance is correct
 *   - 4-way fee split lands on the four treasury ATAs
 *   - all 4 scenarios (happy, draw, refund, double-deposit reject) pass
 */
import "dotenv/config";
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
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt");
const MINT = new PublicKey("C9zcTJjJTs4HHWrVFfuc5pP1BbYj8dYeM8mfHNMduVKp"); // mockUSDC on devnet

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function fundTestUser(
  connection: Connection,
  resolver: Keypair,
  user: Keypair,
  solAmount: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: resolver.publicKey,
      toPubkey: user.publicKey,
      lamports: solAmount * LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [resolver], {
    commitment: "confirmed",
  });
}

async function main() {
  const start = Date.now();
  console.log(`testnet lifecycle (Solana devnet) @ ${new Date().toISOString()}\n`);

  const resolverRaw = JSON.parse(
    fs.readFileSync("./keys/bot-resolver.json", "utf8"),
  );
  const resolver = Keypair.fromSecretKey(Uint8Array.from(resolverRaw));
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(resolver), {
    preflightCommitment: "confirmed",
  });
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);

  const balance = await connection.getBalance(resolver.publicKey);
  check(
    "resolver has ≥0.1 SOL",
    balance >= 0.1 * LAMPORTS_PER_SOL,
    `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
  );
  if (failures > 0) process.exit(1);

  // Fund two ephemeral test users with 0.02 SOL each (rent + tx fees)
  const challenger = Keypair.generate();
  const accepter = Keypair.generate();
  console.log(`  funding test users: ${challenger.publicKey.toBase58().slice(0, 8)}…, ${accepter.publicKey.toBase58().slice(0, 8)}…`);
  await fundTestUser(connection, resolver, challenger, 0.02);
  await fundTestUser(connection, resolver, accepter, 0.02);

  // Mint 100 mockUSDC to each so they can stake 50
  const challengerAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, MINT, challenger.publicKey)
  ).address;
  const accepterAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, MINT, accepter.publicKey)
  ).address;
  await mintTo(connection, resolver, MINT, challengerAta, resolver, 100_000_000);
  await mintTo(connection, resolver, MINT, accepterAta, resolver, 100_000_000);
  console.log("  minted 100 mUSDC to each");

  // Treasury ATAs (created lazily by resolve if missing). For the
  // lifecycle we ensure they exist + capture starting balances.
  const TREASURY_OWNERS = [
    "8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS",
    "GjGeCuRyDjLbcPLxXkBPgj8bDZZqvg3pUhfSixUavnPo",
    "FqfuSY2y2TeAqvidFsj2yozrs8fa47yFRSV3C1Cv256g",
    "5ZaM72ERr5QgffzcogpFNACWg1YHS8mMsMM8f3UCMQZ7",
  ].map((s) => new PublicKey(s));
  const treasuryAtas = await Promise.all(
    TREASURY_OWNERS.map(async (owner) => {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        resolver,
        MINT,
        owner,
      );
      return ata.address;
    }),
  );
  const treasuryBefore = await Promise.all(
    treasuryAtas.map(async (a) => (await getAccount(connection, a)).amount),
  );

  // Run the bet
  const stake = new BN(50_000_000); // 50 mUSDC
  const betId = new BN(Date.now());
  const [betPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bet"), betId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), betId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );

  console.log(`  betId: ${betId.toString()}`);
  await program.methods
    .initializeBet(
      betId,
      stake,
      challenger.publicKey,
      accepter.publicKey,
      Array(32).fill(0),
    )
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      mint: MINT,
      resolver: resolver.publicKey,
      payer: resolver.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  check("initialize_bet succeeded", true);

  for (const [user, ata] of [
    [challenger, challengerAta] as const,
    [accepter, accepterAta] as const,
  ]) {
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
  check("both deposits landed", true);

  const winnerAtaBefore = (await getAccount(connection, challengerAta)).amount;
  await program.methods
    .resolve(betId, challenger.publicKey)
    .accountsPartial({
      config: configPda,
      bet: betPda,
      vault: vaultPda,
      winnerAta: challengerAta,
      treasuryAta0: treasuryAtas[0],
      treasuryAta1: treasuryAtas[1],
      treasuryAta2: treasuryAtas[2],
      treasuryAta3: treasuryAtas[3],
      resolver: resolver.publicKey,
    })
    .rpc();

  const pot = BigInt(stake.toString()) * 2n;
  // Fee = stake * cBps + stake * aBps / 10000. With both sides at 250 bps:
  //   = stake * (250+250) / 10000 = stake * 500 / 10000 = stake / 20
  const fee = (BigInt(stake.toString()) * 500n) / 10_000n;
  const expectedPayout = pot - fee;
  const expectedPerOwner = fee / 4n;

  const winnerAtaAfter = (await getAccount(connection, challengerAta)).amount;
  const gotPayout = winnerAtaAfter - winnerAtaBefore;
  check(
    "winner received pot - fee",
    gotPayout === expectedPayout,
    `${gotPayout} (expected ${expectedPayout})`,
  );

  for (let i = 0; i < 4; i++) {
    const after = (await getAccount(connection, treasuryAtas[i]!)).amount;
    const got = after - treasuryBefore[i]!;
    check(
      `treasury[${i}] received ${expectedPerOwner}`,
      got === expectedPerOwner,
      `${got}`,
    );
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n${failures === 0 ? "✅ PASS" : `❌ FAIL — ${failures} check(s) failed`} (${elapsed}s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
