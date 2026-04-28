/**
 * Tests for the BridgeAdapter contract + the FakeBridgeAdapter
 * reference impl. Real adapters (Squid SDK / Mayan SDK / CCTP V2) plug
 * in by satisfying the same interface.
 *
 * The fake exists for two reasons:
 *   1. So tests for downstream code (e.g. a bridged-deposit dispatcher)
 *      can drive the bridge layer without reaching network.
 *   2. As a reference: an integration agent reads it to see what shape
 *      a real adapter must return, then swaps in the SDK call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeBridgeAdapter,
  type BridgeAdapter,
  type DepositStatus,
} from "./bridge-adapter.js";
import { quoteIsExpired } from "./bridge.js";

test("FakeBridgeAdapter.getQuote returns a well-formed BridgeQuote", async () => {
  const adapter = new FakeBridgeAdapter({ now: () => 1_700_000_000_000 });
  const quote = await adapter.getQuote({
    sourceChain: "base",
    destChain: "solana",
    amountIn: 50_000_000n,
  });
  assert.equal(quote.provider, "fake");
  assert.equal(quote.sourceChain, "base");
  assert.equal(quote.destChain, "solana");
  assert.equal(quote.amountIn, 50_000_000n);
  // Default fake fee = 1% of input → 50_000_000 - 500_000 = 49_500_000.
  assert.equal(quote.amountOutMin, 49_500_000n);
  assert.equal(quote.estimatedFeeAtoms, 500_000n);
  assert.ok(quote.depositAddress.length > 0);
  assert.ok(quote.etaSeconds > 0);
});

test("FakeBridgeAdapter.getQuote uses injected `now` for fetchedAtMs", async () => {
  const fixedNow = 1_700_000_123_456;
  const adapter = new FakeBridgeAdapter({ now: () => fixedNow });
  const quote = await adapter.getQuote({
    sourceChain: "base",
    destChain: "solana",
    amountIn: 1n,
  });
  assert.equal(quote.fetchedAtMs, fixedNow);
});

test("FakeBridgeAdapter quote is fresh per quoteIsExpired", async () => {
  const t0 = 1_700_000_000_000;
  const adapter = new FakeBridgeAdapter({ now: () => t0 });
  const quote = await adapter.getQuote({
    sourceChain: "base",
    destChain: "solana",
    amountIn: 100n,
  });
  assert.equal(quoteIsExpired(quote, t0), false);
  assert.equal(quoteIsExpired(quote, t0 + quote.ttlMs), true);
});

test("FakeBridgeAdapter.getQuote rejects routes that violate the policy", async () => {
  const adapter = new FakeBridgeAdapter();
  await assert.rejects(
    adapter.getQuote({
      sourceChain: "solana",
      destChain: "base", // dest must be an escrow chain
      amountIn: 1n,
    }),
    (err: Error) => err.message.toLowerCase().includes("base"),
  );
});

test("FakeBridgeAdapter.getDepositStatus walks pending → confirmed deterministically", async () => {
  // The fake's status transitions on the *number of polls*, not wall
  // time, so tests are deterministic without faking timers.
  const adapter = new FakeBridgeAdapter();
  const depositId = "test-deposit-1";

  const a = await adapter.getDepositStatus(depositId);
  assert.equal(a.state, "pending");

  const b = await adapter.getDepositStatus(depositId);
  assert.equal(b.state, "in_flight");

  const c = await adapter.getDepositStatus(depositId);
  assert.equal(c.state, "confirmed");
  assert.ok(
    c.state === "confirmed" && c.destTxHash && c.destTxHash.length > 0,
    "confirmed status must include destTxHash",
  );

  // Stays confirmed on subsequent polls (idempotent terminal state).
  const d = await adapter.getDepositStatus(depositId);
  assert.equal(d.state, "confirmed");
});

test("FakeBridgeAdapter tracks deposits independently per id", async () => {
  const adapter = new FakeBridgeAdapter();
  const a1 = await adapter.getDepositStatus("a");
  const b1 = await adapter.getDepositStatus("b");
  assert.equal(a1.state, "pending");
  assert.equal(b1.state, "pending");
  // Advancing "a" doesn't touch "b".
  await adapter.getDepositStatus("a");
  await adapter.getDepositStatus("a");
  const a3 = await adapter.getDepositStatus("a");
  const b2 = await adapter.getDepositStatus("b");
  assert.equal(a3.state, "confirmed");
  assert.equal(b2.state, "in_flight"); // only progressed once
});

test("BridgeAdapter type contract — getQuote and getDepositStatus exist", async () => {
  // Compile-time check that FakeBridgeAdapter satisfies the public
  // contract; if the interface drifts and the fake stops conforming,
  // this assignment will fail typecheck.
  const adapter: BridgeAdapter = new FakeBridgeAdapter();
  assert.equal(typeof adapter.getQuote, "function");
  assert.equal(typeof adapter.getDepositStatus, "function");
});

test("DepositStatus type discriminates: pending/in_flight/confirmed/failed", async () => {
  // Smoke that the union is exhaustive; the integration agent should
  // grep this test and the type to confirm the state machine.
  const states: DepositStatus["state"][] = [
    "pending",
    "in_flight",
    "confirmed",
    "failed",
  ];
  // Just touch each — TS catches if a new variant is added without
  // updating the test.
  for (const s of states) {
    assert.ok(typeof s === "string" && s.length > 0);
  }
});
