/**
 * Tests for monitorBridgedDeposit — polls a BridgeAdapter until the
 * deposit reaches a terminal state (confirmed / failed) or a timeout
 * / abort fires.
 *
 * Uses an injectable delay so tests are deterministic without
 * depending on real wall-clock timing. The production default is
 * setTimeout-based.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorBridgedDeposit } from "./bridge-monitor.js";
import type {
  BridgeAdapter,
  DepositStatus,
} from "./bridge-adapter.js";
import { FakeBridgeAdapter } from "./bridge-adapter.js";

/** Resolves immediately — strips real timing from the loop. */
const noDelay = async () => {};

class ScriptedAdapter implements BridgeAdapter {
  private i = 0;
  constructor(private readonly script: DepositStatus[]) {}
  async getQuote(): Promise<never> {
    throw new Error("not used in monitor tests");
  }
  async getDepositStatus(): Promise<DepositStatus> {
    const next = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    return next!;
  }
  callCount() {
    return this.i;
  }
}

test("monitor returns confirmed when adapter reports confirmed", async () => {
  const adapter = new FakeBridgeAdapter();
  const result = await monitorBridgedDeposit({
    adapter,
    depositId: "test-1",
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed") {
    assert.match(result.destTxHash, /test-1/);
  }
});

test("monitor returns failed when adapter reports failed", async () => {
  const adapter = new ScriptedAdapter([
    { state: "pending" },
    { state: "in_flight" },
    { state: "failed", reason: "bridge timeout upstream" },
  ]);
  const result = await monitorBridgedDeposit({
    adapter,
    depositId: "test-2",
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.match(result.reason, /timeout upstream/);
  }
});

test("monitor returns timeout if no terminal state before deadline", async () => {
  // Adapter reports "pending" forever.
  const adapter = new ScriptedAdapter([{ state: "pending" }]);
  // injectable clock so we don't actually wait. Returns a counter
  // that ticks past the timeout after a few polls.
  let virtualNow = 0;
  const result = await monitorBridgedDeposit({
    adapter,
    depositId: "stuck",
    timeoutMs: 100,
    pollIntervalMs: 50,
    delay: async () => {
      virtualNow += 50;
    },
    now: () => virtualNow,
  });
  assert.equal(result.kind, "timeout");
});

test("monitor honors AbortSignal", async () => {
  const adapter = new ScriptedAdapter([{ state: "pending" }]);
  const ac = new AbortController();
  // Abort after first poll.
  let polls = 0;
  const result = await monitorBridgedDeposit({
    adapter,
    depositId: "abort-me",
    timeoutMs: 10_000,
    pollIntervalMs: 0,
    delay: async () => {
      polls++;
      if (polls === 1) ac.abort();
    },
    signal: ac.signal,
  });
  assert.equal(result.kind, "aborted");
});

test("monitor invokes onUpdate for each non-terminal status", async () => {
  const adapter = new FakeBridgeAdapter();
  const updates: DepositStatus["state"][] = [];
  await monitorBridgedDeposit({
    adapter,
    depositId: "obs",
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
    onUpdate: (s) => updates.push(s.state),
  });
  // FakeBridgeAdapter walks pending → in_flight → confirmed.
  // Caller sees all three (terminal also reported so UI can show success).
  assert.deepEqual(updates, ["pending", "in_flight", "confirmed"]);
});

test("monitor stops polling once terminal — no extra getDepositStatus calls", async () => {
  const adapter = new ScriptedAdapter([
    { state: "in_flight" },
    { state: "confirmed", destTxHash: "0xabc" },
    { state: "failed", reason: "ghost call" }, // should never run
  ]);
  await monitorBridgedDeposit({
    adapter,
    depositId: "no-extra",
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(adapter.callCount(), 2);
});

test("monitor reports timeout details (elapsed + last status)", async () => {
  const adapter = new ScriptedAdapter([
    { state: "pending" },
    { state: "in_flight" },
  ]);
  let virtualNow = 0;
  const result = await monitorBridgedDeposit({
    adapter,
    depositId: "slow",
    timeoutMs: 100,
    pollIntervalMs: 50,
    delay: async () => {
      virtualNow += 50;
    },
    now: () => virtualNow,
  });
  assert.equal(result.kind, "timeout");
  if (result.kind === "timeout") {
    // The last non-terminal status the bridge reported, useful for
    // debugging "stuck in_flight for 30 min" cases vs "never even
    // saw the source-chain tx".
    assert.equal(result.lastStatus.state, "in_flight");
    assert.ok(
      result.elapsedMs >= 100,
      `elapsedMs should be >= timeoutMs, got ${result.elapsedMs}`,
    );
  }
});
