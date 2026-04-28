/**
 * Multi-provider quote router. One call:
 *
 *   const result = await getBestQuoteAcrossProviders(
 *     [squidAdapter, mayanAdapter, cctpAdapter],
 *     { sourceChain, destChain, amountIn },
 *   );
 *
 * Behavior:
 *   - Validates the route once up front via the escrow-policy module
 *     (cheap, prevents N pointless network round-trips on a known-bad
 *     route).
 *   - Fans the quote request out to all adapters in parallel.
 *   - Tolerates per-adapter failures: errors are collected, not
 *     thrown, so a single rate-limit doesn't break the user's flow.
 *   - Returns the best surviving quote via pickCheapestQuote
 *     (highest amountOutMin, tiebreak on lowest estimatedFeeAtoms).
 *
 * Returns a discriminated union so callers exhaustively handle:
 *   - ok            — got a quote (errors may still be non-empty for observability)
 *   - no_quotes     — all adapters failed (or no adapters supplied)
 *   - invalid_route — route violates escrow policy (e.g. dest=base)
 */
import type { BridgeQuote } from "./bridge.js";
import { pickCheapestQuote, validateBridgeRoute } from "./bridge.js";
import type { BridgeAdapter, GetQuoteArgs } from "./bridge-adapter.js";

export type ProviderQuoteError = {
  /** Position in the input adapter array. Useful when adapters are
   *  built dynamically (e.g. from env config) so a logged error maps
   *  back to a known provider. */
  adapterIndex: number;
  reason: string;
};

export type ProviderQuoteResult =
  | { kind: "ok"; quote: BridgeQuote; errors: ProviderQuoteError[] }
  | { kind: "no_quotes"; errors: ProviderQuoteError[] }
  | { kind: "invalid_route"; reason: string };

export async function getBestQuoteAcrossProviders(
  adapters: BridgeAdapter[],
  args: GetQuoteArgs,
): Promise<ProviderQuoteResult> {
  const validation = validateBridgeRoute(args.sourceChain, args.destChain);
  if (!validation.ok) {
    return { kind: "invalid_route", reason: validation.reason };
  }

  const settled = await Promise.allSettled(
    adapters.map((a) => a.getQuote(args)),
  );

  const quotes: BridgeQuote[] = [];
  const errors: ProviderQuoteError[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      quotes.push(r.value);
    } else {
      errors.push({
        adapterIndex: i,
        reason:
          r.reason instanceof Error
            ? r.reason.message
            : String(r.reason),
      });
    }
  });

  const best = pickCheapestQuote(quotes);
  if (!best) {
    return { kind: "no_quotes", errors };
  }
  return { kind: "ok", quote: best, errors };
}
