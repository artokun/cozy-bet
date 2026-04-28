/**
 * Bridge-quote data model + route validation.
 *
 * The actual SDK call (Squid / Mayan / CCTP) is intentionally NOT here
 * — that's a single integration seam for `cozy-bet-lfh`. This module
 * locks the *shape* of a quote and the *policy* about which routes
 * are allowed, so the integration agent only fills in the adapter
 * function (returning `BridgeQuote`) without re-deriving the data
 * model or rediscovering the escrow-chain policy.
 *
 * Composes with apps/bot/src/escrow-policy.ts: a route is valid only
 * if the destination chain is in `ESCROW_CHAINS`.
 */
import { isEscrowChain, isSourceChain } from "./escrow-policy.js";

export type BridgeProvider = "squid" | "mayan" | "cctp";

/**
 * A quote returned by a bridge SDK. All amounts are in the destination
 * token's atomic units (USDC = 6 decimals); we assume USDC on both
 * sides since multi-currency ingest (cozy-bet-b34) is a separate
 * scope.
 */
export type BridgeQuote = {
  provider: BridgeProvider;
  sourceChain: string; // typically a SourceChain
  destChain: string; // typically an EscrowChain
  /** Atoms the user sends on the source chain. */
  amountIn: bigint;
  /** Minimum atoms the user receives on the destination chain. */
  amountOutMin: bigint;
  /** Provider's explicit fee breakdown (gas + protocol fee), in atoms. */
  estimatedFeeAtoms: bigint;
  /** Provider-stated end-to-end ETA. */
  etaSeconds: number;
  /** Wall-clock time the quote was fetched. */
  fetchedAtMs: number;
  /** How long the quote is valid for, from fetchedAtMs. */
  ttlMs: number;
  /** Provider-issued deposit address the user should send to.
   *  Format depends on `sourceChain` (0x-hex on EVM, base58 on Solana). */
  depositAddress: string;
};

export type BridgeRouteValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Is this quote past its TTL? Treats exactly-at-TTL as expired —
 * upstream routers commonly retract a quote a moment before its
 * advertised expiry, so we'd rather refresh than fire the last second.
 */
export function quoteIsExpired(quote: BridgeQuote, nowMs: number): boolean {
  return nowMs - quote.fetchedAtMs >= quote.ttlMs;
}

/**
 * Pick the quote that nets the user the most on the destination chain.
 * Primary signal: highest `amountOutMin`. Tiebreak: lowest
 * `estimatedFeeAtoms` (more reliable than implicit-by-subtraction
 * since providers compute fees differently).
 *
 * Filters out expired quotes when `nowMs` is supplied.
 */
export function pickCheapestQuote(
  quotes: BridgeQuote[],
  nowMs?: number,
): BridgeQuote | null {
  const eligible =
    nowMs === undefined
      ? quotes
      : quotes.filter((q) => !quoteIsExpired(q, nowMs));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, q) => {
    if (q.amountOutMin > best.amountOutMin) return q;
    if (q.amountOutMin < best.amountOutMin) return best;
    // Tie on amountOutMin — prefer the one whose explicit fee is lower.
    return q.estimatedFeeAtoms < best.estimatedFeeAtoms ? q : best;
  });
}

/**
 * Confirm a (source, dest) pair is a valid bridge route under the
 * escrow-chain policy. The destination MUST be an escrow chain; the
 * source MUST be a known source chain (escrow or bridge-source).
 *
 * Same-chain routes (sourceChain === destChain) validate as ok — the
 * dispatcher can short-circuit them as a plain transfer.
 */
export function validateBridgeRoute(
  sourceChain: string,
  destChain: string,
): BridgeRouteValidation {
  if (!isSourceChain(sourceChain)) {
    return {
      ok: false,
      reason: `Source chain "${sourceChain}" is not in SOURCE_CHAINS — bridge ingestion not supported.`,
    };
  }
  if (!isEscrowChain(destChain)) {
    return {
      ok: false,
      reason: `Destination chain "${destChain}" is not an escrow chain. The escrow contract must live on a chain whose validator authority can't unilaterally freeze funds; see escrow-policy.ts.`,
    };
  }
  return { ok: true };
}
