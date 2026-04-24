/**
 * Calls initialize_config on the deployed escrow program. Idempotent: if the
 * config PDA already exists, falls back to update_config.
 *
 *   pnpm tsx scripts/init-config.ts
 *
 * Reads PROGRAM_ID, TREASURY_PUBKEY, RESOLVER_KEYPAIR_PATH, BET_FEE_BPS from .env.
 */
import "dotenv/config";
import {
  AnchorProvider,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import fs from "node:fs";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
const kpPath = process.env.RESOLVER_KEYPAIR_PATH ?? "./keys/bot-resolver.json";
const feeBps = parseInt(process.env.BET_FEE_BPS ?? "250", 10);
const programId = new PublicKey(
  process.env.PROGRAM_ID ?? "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt",
);
const treasury = new PublicKey(
  process.env.TREASURY_PUBKEY ?? "8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS",
);

async function main() {
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(raw));
  const resolverPubkey = authority.publicKey; // bot resolver == admin in MVP

  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    preflightCommitment: "confirmed",
  });
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );

  const existing = await program.account.config.fetchNullable(configPda);
  if (existing) {
    console.log("config exists, updating…");
    const sig = await program.methods
      .updateConfig(feeBps, treasury, resolverPubkey)
      .accountsPartial({ config: configPda, authority: authority.publicKey })
      .rpc();
    console.log(`update_config tx: ${sig}`);
  } else {
    console.log("initializing config…");
    const sig = await program.methods
      .initializeConfig(feeBps, treasury, resolverPubkey)
      .accountsPartial({ config: configPda, authority: authority.publicKey })
      .rpc();
    console.log(`initialize_config tx: ${sig}`);
  }

  const config = await program.account.config.fetch(configPda);
  console.log("config:", {
    treasury: config.treasury.toBase58(),
    resolver: config.resolver.toBase58(),
    feeBps: config.feeBps,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
