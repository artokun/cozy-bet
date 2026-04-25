/**
 * Exercises the dispute flow: both sides claim different winners → status
 * becomes Disputed → admin force-resolves via adminResolve.
 *
 *   set -a && source .env.localnet && set +a
 *   MOCK_USDC_MINT=<mint> pnpm tsx scripts/e2e-dispute.ts
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AnchorProvider,
  Program,
  Wallet,
  BN,
  type Idl,
} from "@coral-xyz/anchor";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";
import { getDb } from "../packages/db/src/index.js";

async function main() {
  const d = getDb(process.env.DATABASE_URL!);
  await d.execute(
    sql`TRUNCATE wallet_link_sessions, bet_events, bets, users RESTART IDENTITY CASCADE`,
  );

  const RPC = process.env.SOLANA_RPC_URL!;
  const resolverRaw = JSON.parse(
    fs.readFileSync(process.env.RESOLVER_KEYPAIR_PATH!, "utf8"),
  );
  const resolver = Keypair.fromSecretKey(Uint8Array.from(resolverRaw));
  const connection = new Connection(RPC, "confirmed");

  const userA = Keypair.generate();
  const userB = Keypair.generate();
  for (const k of [userA, userB]) {
    await connection.confirmTransaction(
      await connection.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL),
      "confirmed",
    );
  }
  let mint: PublicKey;
  if (process.env.MOCK_USDC_MINT) {
    mint = new PublicKey(process.env.MOCK_USDC_MINT);
  } else {
    mint = await createMint(connection, resolver, resolver.publicKey, null, 6);
    process.env.MOCK_USDC_MINT = mint.toBase58();
  }
  for (const u of [userA, userB]) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      resolver,
      mint,
      u.publicKey,
    );
    await mintTo(connection, resolver, mint, ata.address, resolver, 1000 * 10 ** 6);
  }

  const DISCORD_A = "aaaaaaaaaaaaaaaaaa";
  const DISCORD_B = "bbbbbbbbbbbbbbbbbb";
  const DISCORD_ADMIN = "cccccccccccccccccc";

  process.env.DISCORD_BOT_TOKEN ??= "stub";
  process.env.DISCORD_APPLICATION_ID ??= "stub";
  process.env.ADMIN_DISCORD_IDS = DISCORD_ADMIN;

  const {
    proposeBet,
    acceptBet,
    setUserWallet,
    upsertUser,
    initializeOnChain,
    recordDeposit,
    claimWinner,
    adminResolve,
    getBet,
  } = await import("../apps/bot/src/flows.js");

  await upsertUser(DISCORD_A);
  await upsertUser(DISCORD_B);
  await setUserWallet(DISCORD_A, userA.publicKey.toBase58());
  await setUserWallet(DISCORD_B, userB.publicKey.toBase58());

  const _proposed = await proposeBet({
    guildId: "999",
    channelId: "888",
    challengerId: DISCORD_A,
    accepterId: DISCORD_B,
    amount: BigInt(50 * 10 ** 6),
    description: "dispute scenario",
    tokenMint: mint.toBase58(),
  });
  if (!_proposed.ok) throw new Error(`proposeBet failed: ${_proposed.detail}`);
  const betId = _proposed.betId;
  await acceptBet(betId, DISCORD_B);
  const { betPda, vaultPda } = await initializeOnChain(betId);

  const provider = new AnchorProvider(connection, new Wallet(resolver), {
    preflightCommitment: "confirmed",
  });
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);

  async function deposit(user: Keypair) {
    const ata = (
      await getOrCreateAssociatedTokenAccount(connection, resolver, mint, user.publicKey)
    ).address;
    const sig = await program.methods
      .deposit(new BN(betId.toString()))
      .accountsPartial({
        bet: betPda,
        vault: vaultPda,
        depositorAta: ata,
        depositor: user.publicKey,
      })
      .signers([user])
      .rpc();
    await recordDeposit(betId, user.publicKey.toBase58(), sig);
  }
  await deposit(userA);
  await deposit(userB);

  // Each user claims THEMSELVES as winner → dispute
  console.log("\n-- each side claims self as winner --");
  const c1 = await claimWinner(betId, DISCORD_A, DISCORD_A);
  console.log("  A claims A →", c1.outcome);
  const c2 = await claimWinner(betId, DISCORD_B, DISCORD_B);
  console.log("  B claims B →", c2.outcome);
  if (c2.outcome !== "disputed")
    throw new Error(`expected disputed, got ${c2.outcome}`);

  const disputed = await getBet(betId);
  if (disputed?.status !== "disputed") throw new Error("expected disputed");
  console.log("  bet status:", disputed.status);

  // Admin steps in and calls A the winner
  console.log("\n-- admin overrides, declaring A the winner --");
  const outcome = await adminResolve(betId, DISCORD_ADMIN, DISCORD_A);
  console.log("  override tx:", outcome.sig);

  const final = await getBet(betId);
  if (final?.status !== "resolved") throw new Error(`expected resolved, got ${final?.status}`);
  console.log("  final status:", final.status, "winner:", final.winnerId);

  const winnerAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, userA.publicKey)
  ).address;
  const winnerBalance = (await getAccount(connection, winnerAta)).amount;
  if (winnerBalance !== 1047500000n) throw new Error(`unexpected balance: ${winnerBalance}`);
  console.log("  A balance:", winnerBalance, "(expected 1047500000)");

  console.log("\n✅ dispute e2e passed");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
