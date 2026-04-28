/**
 * Polls a BridgeAdapter for a deposit until it reaches a terminal
 * state (`confirmed` / `failed`) or the loop hits a timeout / abort.
 *
 * Design choices:
 *   - `delay` and `now` are injectable so tests don't depend on real
 *     timers. Production defaults are setTimeout / Date.now.
 *   - `onUpdate(status)` fires for *every* status (including terminal)
 *     so callers can drive a UI: "in_flight (45s elapsed)" → "confirmed!".
 *   - Returns a discriminated union with rich timeout context (last
 *     non-terminal status + elapsed ms) for debugging stuck deposits.
 *   - Stops polling immediately on terminal state — no off-by-one
 *     extra getDepositStatus call.
 */
import type { BridgeAdapter, DepositStatus } from "./bridge-adapter.js";

export type MonitorResult =
  | { kind: "confirmed"; destTxHash: string; elapsedMs: number }
  | { kind: "failed"; reason: string; elapsedMs: number }
  | {
      kind: "timeout";
      elapsedMs: number;
      lastStatus: DepositStatus;
    }
  | { kind: "aborted" };

export type MonitorArgs = {
  adapter: BridgeAdapter;
  depositId: string;
  /** Wall-time budget. */
  timeoutMs: number;
  /** Sleep between polls. */
  pollIntervalMs: number;
  /** Optional caller-cancel signal. */
  signal?: AbortSignal;
  /** Called for every status the adapter reports, including terminal. */
  onUpdate?: (status: DepositStatus) => void;
  /** Injectable for tests. Defaults to setTimeout-based delay. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
};

const defaultDelay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function monitorBridgedDeposit(
  args: MonitorArgs,
): Promise<MonitorResult> {
  const delay = args.delay ?? defaultDelay;
  const now = args.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + args.timeoutMs;

  let lastStatus: DepositStatus = { state: "pending" };

  while (true) {
    if (args.signal?.aborted) return { kind: "aborted" };

    const status = await args.adapter.getDepositStatus(args.depositId);
    lastStatus = status;
    args.onUpdate?.(status);

    if (status.state === "confirmed") {
      return {
        kind: "confirmed",
        destTxHash: status.destTxHash,
        elapsedMs: now() - startedAt,
      };
    }
    if (status.state === "failed") {
      return {
        kind: "failed",
        reason: status.reason,
        elapsedMs: now() - startedAt,
      };
    }

    // Non-terminal — sleep and check again, unless we're past the deadline.
    await delay(args.pollIntervalMs);

    if (args.signal?.aborted) return { kind: "aborted" };
    if (now() >= deadline) {
      return {
        kind: "timeout",
        elapsedMs: now() - startedAt,
        lastStatus,
      };
    }
  }
}
