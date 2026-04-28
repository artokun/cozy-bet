/**
 * BridgeAdapter — the contract every bridge integration must satisfy.
 *
 * Real implementations:
 *   - SquidBridgeAdapter (Axelar-based, broadest chain support)
 *   - MayanBridgeAdapter (Solana-native, fastest for SOL ↔ EVM)
 *   - CctpBridgeAdapter  (Circle's Cross-Chain Transfer Protocol V2)
 *
 * The integration agent for cozy-bet-lfh writes one of these
 * (probably Squid first per beads notes), satisfying this interface.
 * Downstream code (createBridgedDeposit, monitorBridgedDeposit) then
 * works against any adapter.
 *
 * FakeBridgeAdapter (below) is the canonical reference: read it to
 * see what shape a real adapter must return, then swap in the SDK
 * call.
 */
import type { BridgeQuote } from "./bridge.js";
import { validateBridgeRoute } from "./bridge.js";

export type GetQuoteArgs = {
  sourceChain: string;
  destChain: string;
  /** Amount in source-chain atoms. USDC = 6 dec on both EVM and Solana. */
  amountIn: bigint;
};

/** State machine for an in-flight bridge deposit. Discriminated union
 *  so callers exhaustively handle the four states. */
export type DepositStatus =
  /** Quote issued; user hasn't sent funds yet (or the source-chain tx
   *  hasn't been observed by the bridge). */
  | { state: "pending" }
  /** Bridge has the source-chain deposit but the destination tx
   *  hasn't landed yet. CCTP V2 fast-path: ~30s; Squid generic: ~2min. */
  | { state: "in_flight" }
  /** Funds delivered on the destination chain. Terminal success. */
  | { state: "confirmed"; destTxHash: string }
  /** Bridge failed mid-flight (refund flow handled by the bridge
   *  itself; cozy-bet treats this as "user must retry"). */
  | { state: "failed"; reason: string };

export interface BridgeAdapter {
  /** Fetch a quote for (sourceChain, destChain, amountIn). Should
   *  validate the route via validateBridgeRoute and reject early. */
  getQuote(args: GetQuoteArgs): Promise<BridgeQuote>;
  /** Poll the bridge for the status of a previously-issued deposit.
   *  `depositId` is whatever the adapter returned at quote time
   *  (typically embedded in `quote.depositAddress` metadata). */
  getDepositStatus(depositId: string): Promise<DepositStatus>;
}

// ---------------------------------------------------------------
// Fake adapter — for tests and as a reference impl
// ---------------------------------------------------------------

type FakeOptions = {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Fee charged as a fraction of amountIn. Default 1% (100 bps). */
  feeBps?: number;
  /** ETA the fake reports. */
  etaSeconds?: number;
  /** TTL for issued quotes. */
  ttlMs?: number;
};

const FAKE_BPS_DENOMINATOR = 10_000n;

/**
 * Deterministic fake. Uses a per-instance counter to advance deposit
 * status: pending → in_flight → confirmed (one step per poll). State
 * is keyed by depositId so concurrent deposits track independently.
 *
 * Real adapters never depend on poll-count for state transitions —
 * they query the bridge SDK. The fake uses poll-count because tests
 * become flaky when they depend on wall-clock time.
 */
export class FakeBridgeAdapter implements BridgeAdapter {
  private readonly now: () => number;
  private readonly feeBps: bigint;
  private readonly etaSeconds: number;
  private readonly ttlMs: number;
  private readonly depositPolls = new Map<string, number>();

  constructor(opts: FakeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.feeBps = BigInt(opts.feeBps ?? 100); // 1% default
    this.etaSeconds = opts.etaSeconds ?? 60;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  async getQuote(args: GetQuoteArgs): Promise<BridgeQuote> {
    const validation = validateBridgeRoute(args.sourceChain, args.destChain);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    const fee = (args.amountIn * this.feeBps) / FAKE_BPS_DENOMINATOR;
    return {
      provider: "fake",
      sourceChain: args.sourceChain,
      destChain: args.destChain,
      amountIn: args.amountIn,
      amountOutMin: args.amountIn - fee,
      estimatedFeeAtoms: fee,
      etaSeconds: this.etaSeconds,
      fetchedAtMs: this.now(),
      ttlMs: this.ttlMs,
      depositAddress: `fake-deposit-addr-${args.sourceChain}-${args.amountIn}`,
    };
  }

  async getDepositStatus(depositId: string): Promise<DepositStatus> {
    const polls = (this.depositPolls.get(depositId) ?? 0) + 1;
    this.depositPolls.set(depositId, polls);
    if (polls === 1) return { state: "pending" };
    if (polls === 2) return { state: "in_flight" };
    return {
      state: "confirmed",
      destTxHash: `fake-dest-tx-${depositId}`,
    };
  }
}
