/**
 * End-to-end bridged-deposit flow. Composes:
 *
 *   bridge-router.getBestQuoteAcrossProviders   (validate + quote fan-out)
 *   bridge-monitor.monitorBridgedDeposit        (poll until terminal)
 *
 * One call for the integration agent — input the adapters and the
 * route, get a result that exhaustively covers every failure mode
 * plus the success carrying both the chosen quote and the destination
 * tx hash (everything needed to fire the on-chain init).
 *
 * Usage in the bot:
 *
 *   const result = await executeBridgedDeposit({
 *     adapters: [squidAdapter, mayanAdapter, cctpAdapter],
 *     route: { sourceChain, destChain, amountIn },
 *     timeoutMs: 5 * 60 * 1000,
 *     pollIntervalMs: 2_000,
 *   });
 *   switch (result.kind) {
 *     case "confirmed":     return chainInitializeBet(...);
 *     case "invalid_route": return error("route disallowed");
 *     case "no_quotes":     return error("no provider available");
 *     case "deposit_timeout":
 *     case "deposit_failed":
 *     case "aborted":       return surfaceTo(user, result);
 *   }
 */
import type { BridgeAdapter, DepositStatus, GetQuoteArgs } from "./bridge-adapter.js";
import { getBestQuoteAcrossProviders, type ProviderQuoteError } from "./bridge-router.js";
import { monitorBridgedDeposit } from "./bridge-monitor.js";
import type { BridgeQuote } from "./bridge.js";

export type BridgeFlowResult =
  | {
      kind: "confirmed";
      quote: BridgeQuote;
      destTxHash: string;
      elapsedMs: number;
    }
  | { kind: "invalid_route"; reason: string }
  | { kind: "no_quotes"; errors: ProviderQuoteError[] }
  | {
      kind: "deposit_timeout";
      quote: BridgeQuote;
      lastStatus: DepositStatus;
      elapsedMs: number;
    }
  | {
      kind: "deposit_failed";
      quote: BridgeQuote;
      reason: string;
      elapsedMs: number;
    }
  | { kind: "aborted" };

export type BridgeFlowArgs = {
  adapters: BridgeAdapter[];
  route: GetQuoteArgs;
  /** Total budget for the deposit-monitor loop. */
  timeoutMs: number;
  /** Sleep between status polls. */
  pollIntervalMs: number;
  /** Fires once with the chosen quote (after fan-out). */
  onQuote?: (q: BridgeQuote) => void;
  /** Fires for every status the monitor observes (incl. terminal). */
  onDepositUpdate?: (s: DepositStatus) => void;
  /** Caller-cancel signal — checked at multiple points. */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to setTimeout-based delay. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
};

/**
 * The deposit identifier passed to `getDepositStatus` is, by convention,
 * the quote's `depositAddress` — Squid, Mayan and CCTP V2 all use the
 * deposit address as the lookup key. Real adapters can override by
 * embedding additional context in the address string.
 */
function depositIdFromQuote(q: BridgeQuote): string {
  return q.depositAddress;
}

export async function executeBridgedDeposit(
  args: BridgeFlowArgs,
): Promise<BridgeFlowResult> {
  if (args.signal?.aborted) return { kind: "aborted" };

  const quoteResult = await getBestQuoteAcrossProviders(
    args.adapters,
    args.route,
  );

  if (quoteResult.kind === "invalid_route") {
    return { kind: "invalid_route", reason: quoteResult.reason };
  }
  if (quoteResult.kind === "no_quotes") {
    return { kind: "no_quotes", errors: quoteResult.errors };
  }

  const { quote, adapterIndex } = quoteResult;
  args.onQuote?.(quote);

  // The router returned which adapter produced the chosen quote —
  // poll that one. Squid and Mayan namespace their deposit ids, so
  // calling getDepositStatus on a non-issuing adapter would fail.
  const issuingAdapter = args.adapters[adapterIndex]!;

  const monitorResult = await monitorBridgedDeposit({
    adapter: issuingAdapter,
    depositId: depositIdFromQuote(quote),
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
    onUpdate: args.onDepositUpdate,
    signal: args.signal,
    delay: args.delay,
    now: args.now,
  });

  switch (monitorResult.kind) {
    case "confirmed":
      return {
        kind: "confirmed",
        quote,
        destTxHash: monitorResult.destTxHash,
        elapsedMs: monitorResult.elapsedMs,
      };
    case "failed":
      return {
        kind: "deposit_failed",
        quote,
        reason: monitorResult.reason,
        elapsedMs: monitorResult.elapsedMs,
      };
    case "timeout":
      return {
        kind: "deposit_timeout",
        quote,
        lastStatus: monitorResult.lastStatus,
        elapsedMs: monitorResult.elapsedMs,
      };
    case "aborted":
      return { kind: "aborted" };
  }
}
