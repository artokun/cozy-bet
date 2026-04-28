/**
 * Tests for the end-to-end bridged-deposit flow. This is the capstone
 * that ties bridge-router + bridge-monitor together — the say-bet
 * integration agent calls this one function:
 *
 *   const result = await executeBridgedDeposit({
 *     adapters: [squid, mayan, cctp],
 *     route: { sourceChain: "base", destChain: "solana", amountIn },
 *     timeoutMs, pollIntervalMs,
 *   });
 *
 * ...and gets a discriminated union result that exhaustively covers
 * the failure modes (no quote, bad route, deposit timeout, deposit
 * failed, aborted) plus a success carrying both the chosen quote and
 * the destination tx hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeBridgedDeposit } from "./bridge-flow.js";
import {
  FakeBridgeAdapter,
  type BridgeAdapter,
  type DepositStatus,
} from "./bridge-adapter.js";

const noDelay = async () => {};

class FailingAdapter implements BridgeAdapter {
  async getQuote(): Promise<never> {
    throw new Error("upstream 503");
  }
  async getDepositStatus(): Promise<DepositStatus> {
    return { state: "pending" };
  }
}

class StuckAdapter implements BridgeAdapter {
  // Quote fine, but deposit never advances past pending.
  async getQuote() {
    return {
      provider: "fake" as const,
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
      amountOutMin: 49_500_000n,
      estimatedFeeAtoms: 500_000n,
      etaSeconds: 60,
      fetchedAtMs: 1_700_000_000_000,
      ttlMs: 5 * 60 * 1000,
      depositAddress: "stuck-addr",
    };
  }
  async getDepositStatus(): Promise<DepositStatus> {
    return { state: "pending" };
  }
}

test("happy path — quote, deposit, confirm — returns confirmed result", async () => {
  const adapter = new FakeBridgeAdapter();
  const result = await executeBridgedDeposit({
    adapters: [adapter],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
    },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed") {
    // The result includes both the chosen quote and the destination
    // tx hash — caller has everything to fire the on-chain init.
    assert.equal(result.quote.provider, "fake");
    assert.equal(result.quote.amountIn, 50_000_000n);
    assert.ok(result.destTxHash.length > 0);
  }
});

test("invalid route — fails fast without contacting any adapter", async () => {
  // Adapter array isn't even queried — the route is rejected at the
  // policy layer.
  const failing = new FailingAdapter();
  const result = await executeBridgedDeposit({
    adapters: [failing],
    route: { sourceChain: "solana", destChain: "base", amountIn: 1n },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "invalid_route");
  if (result.kind === "invalid_route") {
    assert.match(result.reason.toLowerCase(), /base|escrow/);
  }
});

test("no quotes — every adapter throws, caller sees aggregated errors", async () => {
  const result = await executeBridgedDeposit({
    adapters: [new FailingAdapter(), new FailingAdapter()],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 1_000_000n,
    },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "no_quotes");
  if (result.kind === "no_quotes") {
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0]!.reason, /503/);
  }
});

test("deposit times out — surfaces the chosen quote + last status", async () => {
  let virtualNow = 0;
  const result = await executeBridgedDeposit({
    adapters: [new StuckAdapter()],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
    },
    timeoutMs: 100,
    pollIntervalMs: 50,
    delay: async () => {
      virtualNow += 50;
    },
    now: () => virtualNow,
  });
  assert.equal(result.kind, "deposit_timeout");
  if (result.kind === "deposit_timeout") {
    // Caller still gets the quote (so they can render the deposit
    // address for a manual retry) and lastStatus (for triage).
    assert.equal(result.quote.depositAddress, "stuck-addr");
    assert.equal(result.lastStatus.state, "pending");
  }
});

test("AbortSignal mid-flow returns aborted", async () => {
  const adapter = new FakeBridgeAdapter();
  const ac = new AbortController();
  let polls = 0;
  const result = await executeBridgedDeposit({
    adapters: [adapter],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
    },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: async () => {
      polls++;
      if (polls === 1) ac.abort();
    },
    signal: ac.signal,
  });
  assert.equal(result.kind, "aborted");
});

test("multi-adapter — polls the issuing adapter, not the first one", async () => {
  // Regression for a bug in the first impl: a `find(async ...)` lookup
  // always returned adapters[0] because `find` checks promise
  // truthiness. With one adapter the bug was invisible. With two
  // adapters where the *second* wins on price, polling the first
  // adapter would get stuck pending forever — so a confirmed result
  // here proves polling routed to the right adapter.
  const stuck = new StuckAdapter();
  const fast = new FakeBridgeAdapter({ feeBps: 50 }); // 0.5%, beats stuck (1%)
  const result = await executeBridgedDeposit({
    adapters: [stuck, fast],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
    },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind === "confirmed") {
    // The cheaper provider (fast) is what we routed polling to. If we
    // had polled `stuck` (always pending), the test would time out.
    assert.equal(result.quote.estimatedFeeAtoms, 250_000n); // 0.5% of 50M
  }
});

test("onQuote and onDepositUpdate hooks fire", async () => {
  const adapter = new FakeBridgeAdapter();
  let chosenProvider = "";
  const updates: DepositStatus["state"][] = [];
  await executeBridgedDeposit({
    adapters: [adapter],
    route: {
      sourceChain: "base",
      destChain: "solana",
      amountIn: 50_000_000n,
    },
    timeoutMs: 1000,
    pollIntervalMs: 0,
    delay: noDelay,
    onQuote: (q) => {
      chosenProvider = q.provider;
    },
    onDepositUpdate: (s) => updates.push(s.state),
  });
  assert.equal(chosenProvider, "fake");
  assert.deepEqual(updates, ["pending", "in_flight", "confirmed"]);
});
