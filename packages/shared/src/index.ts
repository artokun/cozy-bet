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
