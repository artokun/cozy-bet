/**
 * Exercises the bot's flows.ts state machine end-to-end against the local
 * validator + local Postgres, bypassing Discord. Simulates two users.
 *
 * Prereqs: local validator running, program deployed, config initialized,
 * postgres running, migrations applied, .env.localnet loaded.
 *
 * Needs env: MOCK_USDC_MINT (set after mint-mock-usdc.ts), rest from .env.localnet.
 *
 *   set -a && source .env.localnet && set +a
 *   MOCK_USDC_MINT=<mint> pnpm tsx scripts/e2e-bot-flows.ts
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
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet, BN, type Idl } from "@coral-xyz/anchor";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";
import { getDb } from "../packages/db/src/index.js";

const RPC = process.env.SOLANA_RPC_URL!;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);

// Dynamic imports so env is read first
async function main() {
  // Clean DB
  const d = getDb(process.env.DATABASE_URL!);
  await d.execute(
    sql`TRUNCATE wallet_link_sessions, bet_events, bets, users RESTART IDENTITY CASCADE`,
  );

  const resolverRaw = JSON.parse(
    fs.readFileSync(process.env.RESOLVER_KEYPAIR_PATH!, "utf8"),
  );
  const resolver = Keypair.fromSecretKey(Uint8Array.from(resolverRaw));
  const connection = new Connection(RPC, "confirmed");

  // Two test users — not linked anywhere
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  for (const k of [userA, userB]) {
    await connection.confirmTransaction(
      await connection.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL),
      "confirmed",
    );
  }

  // If MOCK_USDC_MINT is set use it, else mint a fresh one. Mint tokens.
  let mint: PublicKey;
  if (process.env.MOCK_USDC_MINT) {
    mint = new PublicKey(process.env.MOCK_USDC_MINT);
  } else {
    mint = await createMint(connection, resolver, resolver.publicKey, null, 6);
    process.env.MOCK_USDC_MINT = mint.toBase58();
    console.log("created mint:", mint.toBase58());
  }
  for (const u of [userA, userB]) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      resolver,
      mint,
      u.publicKey,
    );
    await mintTo(
      connection,
      resolver,
      mint,
      ata.address,
      resolver,
      1000 * 10 ** 6,
    );
  }

  // Stub Discord creds — bot/env.ts validates them on import but this test
  // doesn't touch the Discord gateway.
  process.env.DISCORD_BOT_TOKEN ??= "stub";
  process.env.DISCORD_APPLICATION_ID ??= "stub";

  // Import flows AFTER env is prepared
  const {
    proposeBet,
    acceptBet,
    setUserWallet,
    upsertUser,
    initializeOnChain,
    recordDeposit,
    claimWinner,
    getBet,
  } = await import("../apps/bot/src/flows.js");

  const DISCORD_A = "111111111111111111";
  const DISCORD_B = "222222222222222222";

  await upsertUser(DISCORD_A);
  await upsertUser(DISCORD_B);
  await setUserWallet(DISCORD_A, userA.publicKey.toBase58());
  await setUserWallet(DISCORD_B, userB.publicKey.toBase58());

  // 1. Propose
  const _proposed = await proposeBet({
    guildId: "999",
    channelId: "888",
    challengerId: DISCORD_A,
    accepterId: DISCORD_B,
    amount: BigInt(50 * 10 ** 6),
    description: "1v1 in Apex",
    tokenMint: mint.toBase58(),
  });
  if (!_proposed.ok) throw new Error(`proposeBet failed: ${_proposed.detail}`);
  const betId = _proposed.betId;
  console.log("proposed bet", betId.toString());

  // 2. Accept
  await acceptBet(betId, DISCORD_B);
  console.log("accepted");

  // 3. Initialize on-chain
  const { sig: initSig, betPda, vaultPda } = await initializeOnChain(betId);
  console.log("initialized on-chain tx:", initSig);

  // 4. Both deposit on-chain (users must sign their own transactions)
  const provider = new AnchorProvider(connection, new Wallet(resolver), {
    preflightCommitment: "confirmed",
  });
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);

  async function deposit(user: Keypair) {
    const ata = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        resolver,
        mint,
        user.publicKey,
      )
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
    const result = await recordDeposit(betId, user.publicKey.toBase58(), sig);
    console.log(
      `  ${user.publicKey.toBase58().slice(0, 8)}… deposited, fullyFunded=${result.fullyFunded}`,
    );
  }
  await deposit(userA);
  await deposit(userB);

  const funded = await getBet(betId);
  if (funded?.status !== "funded") throw new Error(`expected funded, got ${funded?.status}`);

  // 5. Both claim winner (userA wins)
  console.log("both claim userA as winner…");
  const c1 = await claimWinner(betId, DISCORD_A, DISCORD_A);
  console.log("  first claim:", c1.outcome);
  const c2 = await claimWinner(betId, DISCORD_B, DISCORD_A);
  console.log("  second claim:", c2.outcome);
  if (c2.outcome !== "resolved") throw new Error(`expected resolved, got ${c2.outcome}`);

  const final = await getBet(betId);
  if (final?.status !== "resolved") throw new Error(`expected resolved, got ${final?.status}`);
  console.log("final status:", final.status, "winner:", final.winnerId, "tx:", final.resolutionTxSig);

  // 6. Verify on-chain: winnerA received 97.5, treasury received 2.5
  const winnerAta = (
    await getOrCreateAssociatedTokenAccount(connection, resolver, mint, userA.publicKey)
  ).address;
  const winnerBalance = (await getAccount(connection, winnerAta)).amount;
  console.log(
    `userA mUSDC balance: ${winnerBalance} (started 1000, deposited -50, won +97.5 → expect 1047.5 = 1047500000)`,
  );
  if (winnerBalance !== 1047500000n) throw new Error(`balance mismatch: ${winnerBalance}`);

  console.log("\n✅ bot flows e2e passed");
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
