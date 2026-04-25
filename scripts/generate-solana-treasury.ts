/**
 * Generate 4 Solana treasury keypairs (placeholders for testnet/devnet).
 * Mainnet should swap to real cofounder pubkeys via update_config.
 *
 *   pnpm tsx scripts/generate-solana-treasury.ts
 *
 * Reuses the existing keys/treasury.json (slot 0) if present.
 */
import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

const KEYS_DIR = path.resolve(process.cwd(), "keys");
fs.mkdirSync(KEYS_DIR, { recursive: true });

function loadOrGen(name: string): Keypair {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), {
    mode: 0o600,
  });
  return kp;
}

// Slot 0: reuse the existing keys/treasury.json from the v1 era.
const slots = [
  loadOrGen("treasury"),
  loadOrGen("treasury-2"),
  loadOrGen("treasury-3"),
  loadOrGen("treasury-4"),
];

console.log("=== Solana treasury slots (placeholders) ===");
slots.forEach((k, i) => {
  console.log(`  TREASURY_OWNER_${i + 1}=${k.publicKey.toBase58()}`);
});
console.log("\n.env stanza (paste into .env):\n");
slots.forEach((k, i) => {
  console.log(`TREASURY_OWNER_${i + 1}=${k.publicKey.toBase58()}`);
});
