/**
 * Helpers for the `PENDING:<reason>:<unix-ms>` lock sentinel format
 * used by claimResolutionLock / applyShareDiscount / initializeOnChain.
 * Pure module so tests can exercise the parser without dragging in DB
 * or chain client dependencies.
 */

/**
 * Format the sentinel for a fresh lock acquisition. Embeds the current
 * wall-clock so the watchdog can age locks by their acquisition time
 * rather than by the bet's creation time (the bet may be weeks old
 * with a lock just acquired).
 */
export function formatLockSentinel(reason: string, nowMs: number): string {
  return `PENDING:${reason}:${nowMs}`;
}

/**
 * Returns the embedded ms timestamp from a sentinel, or null if the
 * value isn't a sentinel or the timestamp is unparseable. A null
 * return on a `PENDING:*` value means the sentinel is from before the
 * timestamp format change — callers should treat it as stale (worst
 * case: clears a just-acquired legacy lock mid-deploy, user retries).
 */
export function lockAcquiredAt(sentinel: string | null): number | null {
  if (!sentinel || !sentinel.startsWith("PENDING:")) return null;
  const lastColon = sentinel.lastIndexOf(":");
  // Only one colon (`PENDING:reason`, no timestamp) → legacy format.
  if (lastColon === "PENDING:".length - 1) return null;
  const raw = sentinel.slice(lastColon + 1);
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

/**
 * Should this lock be cleared? `null` value or non-sentinel → no.
 * Legacy sentinel without timestamp → yes (treat as stale). Otherwise
 * yes only if older than `staleMs`.
 */
export function isLockStale(
  sentinel: string | null,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!sentinel?.startsWith("PENDING:")) return false;
  const acquired = lockAcquiredAt(sentinel);
  if (acquired === null) return true;
  return nowMs - acquired > staleMs;
}
