/**
 * Exponential-backoff retry wrapper for transient async failures.
 *
 * Use it to wrap a network-bound call that *sometimes* fails for
 * reasons unrelated to the request itself — rate limits, transient
 * 5xxs, dropped connections. Bridge adapters are the canonical
 * use-case: Squid rate-limits, Mayan returns 5xxs under load.
 *
 *   const quote = await withRetry(
 *     () => squid.getQuote(args),
 *     { maxAttempts: 4, baseDelayMs: 250 },
 *   );
 *
 * Backoff: baseDelayMs × 2^(attempt-1), capped at maxDelayMs (default
 * 30s). Default `isRetryable` matches /429|503|504|timeout|ECONN/i so
 * common transient HTTP / network errors retry but programmer bugs
 * (TypeError, etc.) fail fast.
 */

const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRYABLE = /(429|503|504|timeout|ECONN)/i;

export type RetryOptions = {
  maxAttempts: number;
  /** First retry sleeps this long; each subsequent doubles. */
  baseDelayMs: number;
  /** Cap on per-sleep duration. Default 30s. */
  maxDelayMs?: number;
  /** Predicate over the thrown error: should we retry?
   *  Default: matches common transient signals (429/503/504/timeout/ECONN). */
  isRetryable?: (err: Error) => boolean;
  /** Caller-cancel signal. */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
};

const defaultDelay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    isRetryable = (e) => DEFAULT_RETRYABLE.test(e.message),
    signal,
    delay = defaultDelay,
  } = opts;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err;
      if (!isRetryable(err)) throw err;
      if (attempt === maxAttempts) throw err;
      const sleepMs = Math.min(
        baseDelayMs * 2 ** (attempt - 1),
        maxDelayMs,
      );
      await delay(sleepMs);
    }
  }
  // Unreachable — the loop always either returns or throws — but TS
  // wants a fallback expression.
  throw lastError ?? new Error("withRetry: unreachable");
}
