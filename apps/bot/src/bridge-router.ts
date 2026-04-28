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
  | {
      kind: "ok";
      quote: BridgeQuote;
      /** Position in the input adapter array of the adapter that
       *  produced the chosen quote. Use this to route follow-up
       *  calls (getDepositStatus) back to the issuing adapter. */
      adapterIndex: number;
      errors: ProviderQuoteError[];
    }
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

  // Pair each successful quote with its adapterIndex so the caller
  // can route follow-up calls back to the issuing adapter.
  const indexed: { quote: BridgeQuote; adapterIndex: number }[] = [];
  const errors: ProviderQuoteError[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      indexed.push({ quote: r.value, adapterIndex: i });
    } else {
      errors.push({
        adapterIndex: i,
        reason:
          r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  const best = pickCheapestQuote(indexed.map((e) => e.quote));
  if (!best) {
    return { kind: "no_quotes", errors };
  }
  // Recover the adapterIndex of `best` — it's the entry in `indexed`
  // whose quote is reference-equal to what pickCheapestQuote returned.
  const winner = indexed.find((e) => e.quote === best)!;
  return {
    kind: "ok",
    quote: best,
    adapterIndex: winner.adapterIndex,
    errors,
  };
}
