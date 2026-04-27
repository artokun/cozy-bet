/**
 * Pure helpers for the reliability scoring system. Lives in its own
 * module so tests can import without dragging in env / DB / chain
 * client dependencies that flows.ts pulls.
 */

const ON_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Was a bet resolved on-time relative to its deadline?
 *
 *   - `deadline` null/undefined → no deadline set, treat as on-time
 *     (legacy bets that predate the deadline column).
 *   - Otherwise: |now − deadline| ≤ 24h. The window is symmetric so a
 *     bet resolved 12h *before* its deadline still counts as on-time
 *     (rare but valid — e.g. game ends early).
 */
export function isOnTimeResolution(
  now: Date,
  deadline: Date | null | undefined,
): boolean {
  if (!deadline) return true;
  return Math.abs(now.getTime() - deadline.getTime()) <= ON_TIME_WINDOW_MS;
}
