/**
 * Generate EVM (Base / EVM-compatible) keypairs for treasury owners + resolver.
 * Writes encrypted-at-rest to ./keys/evm/. Prints addresses + a .env stanza.
 *
 *   pnpm tsx scripts/generate-evm-keys.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

const KEYS_DIR = path.resolve(process.cwd(), "keys/evm");
fs.mkdirSync(KEYS_DIR, { recursive: true });

function gen(name: string) {
  const pk = generatePrivateKey(); // 0x + 64 hex
  const acc = privateKeyToAccount(pk);
  const file = path.join(KEYS_DIR, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ name, address: acc.address, privateKey: pk }, null, 2),
    { mode: 0o600 },
  );
  return { name, address: acc.address, privateKey: pk, file };
}

const owners = [1, 2, 3, 4].map((i) => gen(`treasury-owner-${i}`));
const resolver = gen("evm-resolver");

console.log("=== Generated keys (saved to ./keys/evm/) ===\n");
for (const k of [...owners, resolver]) {
  console.log(`${k.name.padEnd(20)} ${k.address}`);
}

console.log("\n=== .env additions (Base Sepolia) ===\n");
console.log(`# Bot's signer for resolve / refund / arbiterResolve / initializeBet
RESOLVER_PRIVATE_KEY=${resolver.privateKey}
RESOLVER_ADDRESS=${resolver.address}

# Treasury owners — 0.625% each at 2.5% total fee
TREASURY_OWNER_1=${owners[0].address}
TREASURY_OWNER_2=${owners[1].address}
TREASURY_OWNER_3=${owners[2].address}
TREASURY_OWNER_4=${owners[3].address}
`);

console.log("Fund the resolver address with Base Sepolia ETH:");
console.log("  https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
console.log("Get test USDC from:");
console.log("  https://faucet.circle.com  (select 'Base Sepolia')");
