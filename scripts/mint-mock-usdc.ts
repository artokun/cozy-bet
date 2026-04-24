/**
 * Creates a mockUSDC SPL mint on devnet with 6 decimals, mints 10k tokens
 * to each wallet address passed as CLI arg. Prints the mint pubkey for .env.
 *
 *   pnpm tsx scripts/mint-mock-usdc.ts <wallet1> <wallet2> ...
 *
 * The mint authority is the bot-resolver keypair so the bot can top up wallets
 * later as needed for testing.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "node:fs";

const RPC =
  process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
const KEYPAIR_PATH =
  process.env.RESOLVER_KEYPAIR_PATH ?? "./keys/bot-resolver.json";
const DECIMALS = 6;
const PER_WALLET = 10_000;

async function main() {
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(raw));

  const recipients = process.argv.slice(2).map((s) => new PublicKey(s));
  if (recipients.length === 0) {
    console.error("usage: tsx scripts/mint-mock-usdc.ts <wallet> [wallet...]");
    process.exit(1);
  }

  const connection = new Connection(RPC, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  console.log(
    `payer ${payer.publicKey.toBase58()} has ${bal / LAMPORTS_PER_SOL} SOL`,
  );

  const mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  console.log(`mockUSDC mint: ${mint.toBase58()}`);

  for (const r of recipients) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, r);
    await mintTo(
      connection,
      payer,
      mint,
      ata.address,
      payer,
      BigInt(PER_WALLET) * 10n ** BigInt(DECIMALS),
    );
    console.log(`minted ${PER_WALLET} mUSDC to ${r.toBase58()}`);
  }

  console.log("\nset MOCK_USDC_MINT in .env to:", mint.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
