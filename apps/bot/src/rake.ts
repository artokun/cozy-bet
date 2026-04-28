/**
 * TS mirror of the on-chain rake math (`_resolveCommon` in
 * apps/contracts/src/CozyBetEscrow.sol). Use this when computing
 * expected payout / fee distribution off-chain (admin stats UI,
 * smoke-test assertions, share-discount preview).
 *
 * The contract is canonical. Any change to its rake math MUST be
 * mirrored here, with the same test vectors landing in both
 * apps/contracts/test/CozyBetEscrow.t.sol and rake.test.ts.
 */

const BPS_DENOMINATOR = 10_000n;

export type RakeBreakdown = {
  /** 2 × amount. */
  pot: bigint;
  /** Combined per-side standard fee. */
  standardFee: bigint;
  /** Per-owner share of standardFee (slot 0 also gets the integer-division
   *  remainder; slots 1..3 get exactly perOwnerBase). */
  perOwnerBase: bigint;
  /** Bonus going to slot 0 due to integer division (0..3 atoms). */
  remainder: bigint;
  /** What treasuryOwners[0] receives (= perOwnerBase + remainder). */
  treasuryShare0: bigint;
  /** What treasuryOwners[1..3] each receive (= perOwnerBase). */
  treasuryShare1to3: bigint;
  /** Arbiter fee (0 if mutual-consent resolve). */
  arbiterFee: bigint;
  /** Winner net payout = pot - standardFee - arbiterFee. */
  winnerPayout: bigint;
};

/**
 * Compute the post-resolution payout breakdown for a Funded bet.
 *
 * Mirrors `CozyBetEscrow._resolveCommon` exactly. Order of operations
 * matches the Solidity (integer division truncates the same way at
 * each step). Inputs are in the token's atomic units (USDC = 6dec).
 *
 * @param amount Each side's stake (pot = 2 × amount).
 * @param challengerFeeBps Per-side bps for the challenger.
 * @param accepterFeeBps   Per-side bps for the accepter.
 * @param arbiterFee       Arbiter fee in atoms (0 for mutual-consent).
 */
export function computeRake(args: {
  amount: bigint;
  challengerFeeBps: number;
  accepterFeeBps: number;
  arbiterFee?: bigint;
}): RakeBreakdown {
  const { amount, challengerFeeBps, accepterFeeBps } = args;
  const arbiterFee = args.arbiterFee ?? 0n;

  const pot = amount * 2n;
  const standardFee =
    (amount * BigInt(challengerFeeBps) + amount * BigInt(accepterFeeBps)) /
    BPS_DENOMINATOR;
  const winnerPayout = pot - standardFee - arbiterFee;

  const perOwnerBase = standardFee / 4n;
  const remainder = standardFee - perOwnerBase * 4n;
  const treasuryShare0 = perOwnerBase + remainder;
  const treasuryShare1to3 = perOwnerBase;

  return {
    pot,
    standardFee,
    perOwnerBase,
    remainder,
    treasuryShare0,
    treasuryShare1to3,
    arbiterFee,
    winnerPayout,
  };
}

/**
 * Compute the arbiter fee using the contract's `max(arbiterMinFee,
 * pot * arbiterFeeBpsOfPot / 10000)` formula. Defaults match the
 * deployed config (100 USDC floor, 1% of pot).
 */
export function computeArbiterFee(args: {
  pot: bigint;
  arbiterMinFee?: bigint;
  arbiterFeeBpsOfPot?: number;
}): bigint {
  const minFee = args.arbiterMinFee ?? 100_000_000n; // $100 in 6-dec USDC
  const bpsOfPot = args.arbiterFeeBpsOfPot ?? 100; // 1%
  const byBps = (args.pot * BigInt(bpsOfPot)) / BPS_DENOMINATOR;
  return byBps > minFee ? byBps : minFee;
}
