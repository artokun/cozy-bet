import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export { default as idl } from "./idl.json" with { type: "json" };
export type { Escrow } from "./idl-types.js";

/**
 * Bet lifecycle states. Mirrors the `BetStatus` enum in the Anchor program
 * plus DB-only pre-on-chain states used by the bot before `initialize_bet`
 * ever runs.
 */
export const BetStatus = {
  // Off-chain-only states (before program touches the bet)
  Proposed: "proposed", // /saybet issued, awaiting accepter's Accept button
  Accepted: "accepted", // Both sides accepted; bot about to call initialize_bet
  // On-chain states (mirror Anchor enum)
  Pending: "pending", // Program initialized, awaiting deposits
  Funded: "funded", // Both deposits landed
  Resolved: "resolved", // Winner paid
  Drawn: "drawn", // Both sides agreed to draw, full refund taken
  Refunded: "refunded",
  // Off-chain-only terminal states
  Canceled: "canceled", // Declined before init, or both-party cancel before funding
  Disputed: "disputed", // Both sides claimed different winners
} as const;

export type BetStatus = (typeof BetStatus)[keyof typeof BetStatus];

export const BET_SEED = Buffer.from("bet");
export const VAULT_SEED = Buffer.from("vault");
export const CONFIG_SEED = Buffer.from("config");

function betIdBuf(id: BN | bigint | number): Buffer {
  const bn = BN.isBN(id) ? id : new BN(id.toString());
  return bn.toArrayLike(Buffer, "le", 8);
}

export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function findBetPda(
  programId: PublicKey,
  betId: BN | bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BET_SEED, betIdBuf(betId)],
    programId,
  );
}

export function findVaultPda(
  programId: PublicKey,
  betId: BN | bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, betIdBuf(betId)],
    programId,
  );
}

/** Used by the bot to allocate globally-unique bet_ids. Use a DB sequence in
 * production; this helper exists for scripts and tests. */
export function makeBetId(): BN {
  // 52-bit timestamp + 12-bit random — fits in JS number range AND u64.
  const ts = BigInt(Date.now()) & ((1n << 52n) - 1n);
  const rnd = BigInt(Math.floor(Math.random() * 4096));
  return new BN(((ts << 12n) | rnd).toString());
}

/**
 * 6-character user-facing bet id ("K7M2RX"). Crockford-base32 alphabet minus
 * I/L/O/U so people can't confuse 0/O, 1/I/L, or read it as a slur. ~64 bits
 * of entropy across 6 chars is enough that DB collision is astronomically
 * unlikely; bot retries on uniqueness violation just in case.
 */
const SHORTCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 chars
export function makeShortcode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += SHORTCODE_ALPHABET[Math.floor(Math.random() * SHORTCODE_ALPHABET.length)];
  }
  return s;
}

/** True if a string looks like a shortcode (vs a full bigint bet_id). Used by
 *  the bot to dispatch /resolve and friends to either lookup path.
 *
 *  Accepts the canonical alphabet (`SHORTCODE_ALPHABET`) AND legacy
 *  hex-derived backfill values (0-9, A-F) from migration 0001. New codes
 *  use the canonical alphabet; old ones may still contain 0/1/etc. */
export function isShortcode(s: string): boolean {
  return /^[0-9A-Z]{4,8}$/i.test(s) && !/^\d+$/.test(s); // not all-digits (those are bet ids)
}
