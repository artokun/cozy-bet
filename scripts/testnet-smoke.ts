/**
 * Read-only testnet smoke test. Runs in ~10s. Verifies that:
 *
 * 1. Solana devnet program is deployed at the expected PROGRAM_ID and the
 *    config PDA matches the values we initialized it with.
 * 2. Base Sepolia escrow contract is deployed at the expected address and
 *    public state (treasury owners, fee config) matches.
 *
 * Spends zero funds. Safe to run on any cadence (cron, every-PR CI,
 * heartbeat). Returns exit 0 on PASS, 1 on FAIL.
 *
 *   pnpm tsx scripts/testnet-smoke.ts
 */
import "dotenv/config";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import idl from "../packages/shared/src/idl.json" with { type: "json" };
import type { Escrow } from "../packages/shared/src/idl-types.js";

// Expected config (locked in at deploy time)
const SOLANA_PROGRAM_ID = "nqQkfoyxtzxDBHmyxnJs3KwQVvz5CoFffH8vcQzS6yt";
const SOLANA_TREASURY_OWNERS = [
  "8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS",
  "GjGeCuRyDjLbcPLxXkBPgj8bDZZqvg3pUhfSixUavnPo",
  "FqfuSY2y2TeAqvidFsj2yozrs8fa47yFRSV3C1Cv256g",
  "5ZaM72ERr5QgffzcogpFNACWg1YHS8mMsMM8f3UCMQZ7",
];
const SOLANA_RESOLVER = "BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7";

const BASE_ESCROW_ADDRESS = "0xffcC554C4157B9363ab561237e3cc02626775F71" as Address;
const BASE_TREASURY_OWNERS = [
  "0x4Ed9D7BC382e69e262A5415cA52954aAf0ed45d6",
  "0x131867e52d0c0c745758254E6F83f4beE4Cb10E9",
  "0xA4304Fe0c7eF262747ea4b93de3C587E1080a3b1",
  "0x6974CB63b4eC7f0Ca8D431215A18553f21b94c08",
];
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// ----------------------------- Solana -----------------------------

async function smokeSolana() {
  console.log("== Solana devnet ==");
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const programId = new PublicKey(SOLANA_PROGRAM_ID);

  const programInfo = await connection.getAccountInfo(programId);
  check(
    "program account exists",
    Boolean(programInfo && programInfo.executable),
    programInfo ? `${programInfo.data.length} bytes` : "missing",
  );
  if (!programInfo) return;

  const provider = new AnchorProvider(
    connection,
    new Wallet(Keypair.generate()), // dummy wallet, only needed for read
    { preflightCommitment: "confirmed" },
  );
  const program = new Program<Escrow>(idl as Idl as Escrow, provider);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId,
  );

  const config = await program.account.config.fetchNullable(configPda);
  check("config PDA initialized", Boolean(config));
  if (!config) return;

  for (let i = 0; i < 4; i++) {
    check(
      `treasury_owners[${i}] matches`,
      config.treasuryOwners[i].toBase58() === SOLANA_TREASURY_OWNERS[i],
      config.treasuryOwners[i].toBase58(),
    );
  }
  check(
    "resolver matches",
    config.resolver.toBase58() === SOLANA_RESOLVER,
    config.resolver.toBase58(),
  );
  check(
    "default_fee_bps == 250",
    config.defaultFeeBps === 250,
    String(config.defaultFeeBps),
  );
  check(
    "min_discounted_fee_bps == 150",
    config.minDiscountedFeeBps === 150,
    String(config.minDiscountedFeeBps),
  );
  check(
    "arbiter_min_fee == 100e6",
    config.arbiterMinFee.toString() === "100000000",
    config.arbiterMinFee.toString(),
  );
  check(
    "arbiter_fee_bps_of_pot == 100",
    config.arbiterFeeBpsOfPot === 100,
    String(config.arbiterFeeBpsOfPot),
  );
}

// ----------------------------- Base -----------------------------

const ESCROW_ABI = [
  {
    type: "function",
    name: "treasuryOwners",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "defaultFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "minDiscountedFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "arbiterMinFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "arbiterFeeBpsOfPot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
] as const;

async function smokeBase() {
  console.log("\n== Base Sepolia ==");
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  } as never);
  const code = await client.getBytecode({ address: BASE_ESCROW_ADDRESS });
  check(
    "contract has bytecode",
    Boolean(code && code.length > 2),
    code ? `${(code.length - 2) / 2} bytes` : "no code",
  );
  if (!code) return;

  for (let i = 0; i < 4; i++) {
    const owner = (await client.readContract({
      address: BASE_ESCROW_ADDRESS,
      abi: ESCROW_ABI,
      functionName: "treasuryOwners",
      args: [BigInt(i)],
    })) as Address;
    check(
      `treasuryOwners(${i}) matches`,
      owner.toLowerCase() === BASE_TREASURY_OWNERS[i].toLowerCase(),
      owner,
    );
  }
  const usdc = (await client.readContract({
    address: BASE_ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "token",
  })) as Address;
  check("token() matches USDC", usdc.toLowerCase() === BASE_USDC.toLowerCase(), usdc);
  const defaultFee = await client.readContract({
    address: BASE_ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "defaultFeeBps",
  });
  check("defaultFeeBps == 250", defaultFee === 250, String(defaultFee));
  const minFee = await client.readContract({
    address: BASE_ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "minDiscountedFeeBps",
  });
  check("minDiscountedFeeBps == 150", minFee === 150, String(minFee));
  const arbMin = await client.readContract({
    address: BASE_ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "arbiterMinFee",
  });
  check(
    "arbiterMinFee == 100e6",
    arbMin === 100_000_000n,
    arbMin.toString(),
  );
  const arbBps = await client.readContract({
    address: BASE_ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "arbiterFeeBpsOfPot",
  });
  check("arbiterFeeBpsOfPot == 100", arbBps === 100, String(arbBps));
}

/**
 * Verify the .env values the bot reads at runtime match the expected
 * config baked into this smoke script. Drift is silent otherwise: bot
 * builds transactions referencing the env addresses, the contract
 * uses its own on-chain config, and a mismatch only surfaces as a
 * failed `resolve` instruction at payout time.
 *
 * Skips a check when the env var is unset (operator running smoke
 * locally without bot env may not have all values populated).
 */
function smokeEnvConsistency() {
  console.log("\n== .env vs expected ==");
  const looksLikeEvm = (s: string) => /^0x[0-9a-f]{40}$/i.test(s);
  const looksLikeSolana = (s: string) =>
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !looksLikeEvm(s);
  const checkEnv = (
    name: string,
    expected: string,
    chainKind: "solana" | "evm",
  ) => {
    const actual = process.env[name];
    if (!actual) {
      console.log(`  - ${name} unset (skip)`);
      return;
    }
    // Shape check first — surfaces "EVM address in Solana slot" type
    // mistakes with a clearer message than the byte-equality diff.
    if (chainKind === "solana" && !looksLikeSolana(actual)) {
      check(
        `${name} matches expected`,
        false,
        `${actual} doesn't look like a Solana base58 pubkey (slot expects: ${expected})`,
      );
      return;
    }
    if (chainKind === "evm" && !looksLikeEvm(actual)) {
      check(
        `${name} matches expected`,
        false,
        `${actual} doesn't look like a 0x EVM address (slot expects: ${expected})`,
      );
      return;
    }
    const ok =
      chainKind === "evm"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
    check(
      `${name} matches expected`,
      ok,
      ok ? actual : `${actual} (expected ${expected})`,
    );
  };
  // Solana
  checkEnv("PROGRAM_ID", SOLANA_PROGRAM_ID, "solana");
  checkEnv("TREASURY_OWNER_1", SOLANA_TREASURY_OWNERS[0]!, "solana");
  checkEnv("TREASURY_OWNER_2", SOLANA_TREASURY_OWNERS[1]!, "solana");
  checkEnv("TREASURY_OWNER_3", SOLANA_TREASURY_OWNERS[2]!, "solana");
  checkEnv("TREASURY_OWNER_4", SOLANA_TREASURY_OWNERS[3]!, "solana");
  // Base — checksum case varies by source; EVM kind treats the comparison as
  // case-insensitive.
  checkEnv("EVM_ESCROW_ADDRESS", BASE_ESCROW_ADDRESS, "evm");
  checkEnv("EVM_USDC_ADDRESS", BASE_USDC, "evm");
  checkEnv("EVM_TREASURY_OWNER_1", BASE_TREASURY_OWNERS[0]!, "evm");
  checkEnv("EVM_TREASURY_OWNER_2", BASE_TREASURY_OWNERS[1]!, "evm");
  checkEnv("EVM_TREASURY_OWNER_3", BASE_TREASURY_OWNERS[2]!, "evm");
  checkEnv("EVM_TREASURY_OWNER_4", BASE_TREASURY_OWNERS[3]!, "evm");
}

async function main() {
  const start = Date.now();
  console.log(`testnet smoke @ ${new Date().toISOString()}\n`);
  try {
    await smokeSolana();
  } catch (e: any) {
    console.error("Solana smoke threw:", e?.message ?? e);
    failures++;
  }
  try {
    await smokeBase();
  } catch (e: any) {
    console.error("Base smoke threw:", e?.message ?? e);
    failures++;
  }
  try {
    smokeEnvConsistency();
  } catch (e: any) {
    console.error("env consistency check threw:", e?.message ?? e);
    failures++;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${failures === 0 ? "✅ PASS" : `❌ FAIL — ${failures} check(s) failed`} (${elapsed}s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
