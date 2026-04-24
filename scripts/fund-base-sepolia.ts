/**
 * Fund Base Sepolia wallets via Coinbase Developer Platform faucet SDK.
 *
 * - Requests ETH (gas) for the resolver
 * - Requests USDC for any wallets passed as CLI args (test bettors)
 *
 *   pnpm tsx scripts/fund-base-sepolia.ts <wallet1> <wallet2> ...
 *
 * Reads CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET from .env.
 * The resolver address is derived from keys/evm/evm-resolver.json.
 *
 * CDP rate limits: ~1000 ETH claims/24h, ERC-20 limits vary by token.
 */
import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
import fs from "node:fs";
import path from "node:path";

const NETWORK = "base-sepolia";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env: ${k}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  // SDK reads CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET from env
  requireEnv("CDP_API_KEY_ID");
  requireEnv("CDP_API_KEY_SECRET");
  requireEnv("CDP_WALLET_SECRET");

  const cdp = new CdpClient();

  const resolverPath = path.resolve(
    process.cwd(),
    "keys/evm/evm-resolver.json",
  );
  const resolver = JSON.parse(fs.readFileSync(resolverPath, "utf8")) as {
    address: `0x${string}`;
  };

  const userWallets = process.argv.slice(2) as `0x${string}`[];

  console.log(`== Base Sepolia faucet ==`);
  console.log(`resolver: ${resolver.address}`);
  if (userWallets.length) {
    console.log(`test users: ${userWallets.join(", ")}`);
  }
  console.log();

  // Resolver: ETH only (it's the bot signer, not a bettor)
  console.log(`requesting ETH for resolver…`);
  const ethRes = await cdp.evm.requestFaucet({
    address: resolver.address,
    network: NETWORK,
    token: "eth",
  });
  console.log(`  tx: ${ethRes.transactionHash}`);

  // Test users: ETH + USDC
  for (const w of userWallets) {
    console.log(`requesting ETH for ${w}…`);
    const r1 = await cdp.evm.requestFaucet({
      address: w,
      network: NETWORK,
      token: "eth",
    });
    console.log(`  tx: ${r1.transactionHash}`);

    console.log(`requesting USDC for ${w}…`);
    const r2 = await cdp.evm.requestFaucet({
      address: w,
      network: NETWORK,
      token: "usdc",
    });
    console.log(`  tx: ${r2.transactionHash}`);
  }

  console.log("\n✅ done. Check balances on https://sepolia.basescan.org");
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
