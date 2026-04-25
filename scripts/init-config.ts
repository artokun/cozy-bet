/**
 * Calls initialize_config on the deployed escrow program. Idempotent: if the
 * config PDA already exists, falls back to update_config.
 *
 *   pnpm tsx scripts/init-config.ts
 *
 * Reads PROGRAM_ID, TREASURY_OWNER_1..4, RESOLVER_KEYPAIR_PATH, ARBITER_PUBKEY,
 * BET_FEE_BPS, ARBITER_MIN_FEE, ARBITER_FEE_BPS_OF_POT from .env.
 */
import "dotenv/config";
import {
  AnchorProvider,
  Program,
  Wallet,
  BN,
  type Idl,
} from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import fs from "node:fs";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
const kpPath = process.env.RESOLVER_KEYPAIR_PATH ?? "./keys/bot-resolver.json";
const programId = new PublicKey(
  process.env.PROGRAM_ID ?? "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt",
);

const defaultFeeBps = parseInt(process.env.BET_FEE_BPS ?? "250", 10);
const minDiscountedFeeBps = parseInt(
  process.env.MIN_DISCOUNTED_FEE_BPS ?? "150",
  10,
);
const arbiterMinFee = new BN(process.env.ARBITER_MIN_FEE ?? "100000000"); // $100 USDC at 6 decimals
const arbiterFeeBpsOfPot = parseInt(
  process.env.ARBITER_FEE_BPS_OF_POT ?? "100",
  10,
);

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`missing required env: ${k}`);
    process.exit(1);
  }
  return v;
}

const treasuryOwners: [PublicKey, PublicKey, PublicKey, PublicKey] = [
  new PublicKey(requireEnv("TREASURY_OWNER_1")),
  new PublicKey(requireEnv("TREASURY_OWNER_2")),
  new PublicKey(requireEnv("TREASURY_OWNER_3")),
  new PublicKey(requireEnv("TREASURY_OWNER_4")),
];

async function main() {
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(raw));
  const resolverPubkey = authority.publicKey;
  const arbiterPubkey = process.env.ARBITER_PUBKEY
    ? new PublicKey(process.env.ARBITER_PUBKEY)
    : authority.publicKey;

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
      .updateConfig(
        treasuryOwners,
        resolverPubkey,
        arbiterPubkey,
        defaultFeeBps,
        minDiscountedFeeBps,
        arbiterMinFee,
        arbiterFeeBpsOfPot,
      )
      .accountsPartial({ config: configPda, authority: authority.publicKey })
      .rpc();
    console.log(`update_config tx: ${sig}`);
  } else {
    console.log("initializing config…");
    const sig = await program.methods
      .initializeConfig(
        treasuryOwners,
        resolverPubkey,
        arbiterPubkey,
        defaultFeeBps,
        minDiscountedFeeBps,
        arbiterMinFee,
        arbiterFeeBpsOfPot,
      )
      .accountsPartial({ config: configPda, authority: authority.publicKey })
      .rpc();
    console.log(`initialize_config tx: ${sig}`);
  }

  const config = await program.account.config.fetch(configPda);
  console.log("config:");
  config.treasuryOwners.forEach((o: PublicKey, i: number) => {
    console.log(`  treasury_owner_${i + 1}: ${o.toBase58()}`);
  });
  console.log(`  resolver: ${config.resolver.toBase58()}`);
  console.log(`  arbiter:  ${config.arbiter.toBase58()}`);
  console.log(`  default_fee_bps: ${config.defaultFeeBps}`);
  console.log(`  min_discounted_fee_bps: ${config.minDiscountedFeeBps}`);
  console.log(`  arbiter_min_fee: ${config.arbiterMinFee.toString()}`);
  console.log(`  arbiter_fee_bps_of_pot: ${config.arbiterFeeBpsOfPot}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
