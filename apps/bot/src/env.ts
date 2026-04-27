import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
// Repo root is 4 levels up from apps/bot/src/env.ts
const repoRoot = path.resolve(path.dirname(thisFile), "../../..");
loadDotenv({ path: path.join(repoRoot, ".env") });

const schema = z.object({
  SOLANA_CLUSTER: z.enum(["devnet", "testnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  PROGRAM_ID: z.string().min(32),
  MOCK_USDC_MINT: z.string().min(32),
  TREASURY_OWNER_1: z.string().min(32),
  TREASURY_OWNER_2: z.string().min(32),
  TREASURY_OWNER_3: z.string().min(32),
  TREASURY_OWNER_4: z.string().min(32),
  ARBITER_PUBKEY: z.string().min(32).optional(), // defaults to resolver
  RESOLVER_KEYPAIR_PATH: z.string().default("./keys/bot-resolver.json"),
  ARBITER_KEYPAIR_PATH: z.string().optional(), // defaults to resolver path

  // EVM (Base) — optional; if unset, the bot won't accept Base bets.
  EVM_NETWORK: z.enum(["base-sepolia", "base"]).default("base-sepolia"),
  RESOLVER_PRIVATE_KEY: z.string().optional(), // 0x-prefixed 64-hex
  EVM_ESCROW_ADDRESS: z.string().optional(), // 0x… deployed CozyBetEscrow
  EVM_USDC_ADDRESS: z.string().optional(), // 0x… USDC mint
  EVM_TREASURY_OWNER_1: z.string().optional(),
  EVM_TREASURY_OWNER_2: z.string().optional(),
  EVM_TREASURY_OWNER_3: z.string().optional(),
  EVM_TREASURY_OWNER_4: z.string().optional(),

  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_TEST_GUILD_ID: z.string().optional(),
  DISCORD_GUILD_ALLOWLIST: z.string().optional(), // comma-separated
  USER_ALLOWLIST_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  ADMIN_DISCORD_IDS: z.string().optional(), // comma-separated discord user ids

  // LLM disambig (cozy-bet-4bt). Used to convert ambiguous bet phrasing
  // into a canonical sentence that both parties confirm before the bet is
  // created on-chain. If unset, /saybet still works but skips the
  // disambig step (description is used verbatim).
  ANTHROPIC_API_KEY: z.string().optional(),
  DISAMBIG_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  DATABASE_URL: z.string().url(),

  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  BOT_API_PORT: z
    .string()
    .default("3001")
    .transform((v) => parseInt(v, 10)),

  BET_FEE_BPS: z
    .string()
    .default("250")
    .transform((v) => parseInt(v, 10)),

  // Auto-refund a bet stuck in `pending` for this many minutes. 0 = disabled.
  WATCHDOG_PENDING_REFUND_MINUTES: z
    .string()
    .default("0")
    .transform((v) => parseInt(v, 10)),
  WATCHDOG_INTERVAL_SECONDS: z
    .string()
    .default("120")
    .transform((v) => parseInt(v, 10)),
  /** Enable 24h + 2h pre-deadline nudge DMs. Idempotent per-bet. */
  WATCHDOG_NUDGE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  /** Shared secret gating the read-only admin dashboard endpoints
   *  (e.g. /api/admin/arbiter-cases). Optional — if unset, admin
   *  endpoints return 503 "admin api disabled". When set, the web
   *  page prompts admins for the token. Discord-OAuth gating
   *  (cozy-bet-xw5) supersedes this once it lands. */
  ADMIN_API_TOKEN: z.string().optional(),
  /** X (Twitter) bearer token for /share verification. Optional; if unset
   *  the /confirm-share command rejects with a "verification disabled" msg
   *  rather than trusting the user's submitted URL. */
  X_BEARER_TOKEN: z.string().optional(),
  /** Hashtag /share-d tweets must contain to qualify for the discount.
   *  Default '#cozybet'. Verified case-insensitively. */
  SHARE_HASHTAG: z.string().default("#cozybet"),
  /** Discounted per-side fee bps after a verified share. Default 150
   *  matches the contract's MIN_DISCOUNTED_FEE_BPS floor. */
  SHARE_DISCOUNT_BPS: z
    .string()
    .default("150")
    .transform((v) => parseInt(v, 10)),
});

// Friendly env validation: zod's default .parse() throws a noisy stack
// trace that hides which env vars are actually broken. Wrap so the bot
// fails with a clean list of "missing X / X is too short" lines, then
// exit non-zero. The boot summary in index.ts prints AFTER this, so a
// successful parse is the gate to seeing the summary at all.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "❌ env validation failed — fix the following before starting the bot:",
  );
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".") || "(root)";
    console.error(`   - ${path}: ${issue.message}`);
  }
  console.error(
    "\n   Most vars are listed in .env.example. Copy it to .env and fill in the secrets.",
  );
  process.exit(1);
}
export const env = parsed.data;

export function allowedGuilds(): Set<string> | null {
  if (!env.DISCORD_GUILD_ALLOWLIST) return null;
  return new Set(env.DISCORD_GUILD_ALLOWLIST.split(",").map((s) => s.trim()));
}

export function isAdmin(discordId: string): boolean {
  if (!env.ADMIN_DISCORD_IDS) return false;
  return env.ADMIN_DISCORD_IDS.split(",")
    .map((s) => s.trim())
    .includes(discordId);
}

export function adminDiscordIds(): string[] {
  if (!env.ADMIN_DISCORD_IDS) return [];
  return env.ADMIN_DISCORD_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
