/**
 * Pure tests for the bridge-quote data model. The actual SDK call
 * (Squid / Mayan / CCTP) lives at a single integration seam later
 * (see beads cozy-bet-lfh). Locking the shape + the route-validation
 * logic in tests now means the integration agent only fills in one
 * adapter function — the rest is already shaped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickCheapestQuote,
  quoteIsExpired,
  validateBridgeRoute,
  type BridgeQuote,
} from "./bridge.js";

const baseQuote = (overrides: Partial<BridgeQuote> = {}): BridgeQuote => ({
  provider: "squid",
  sourceChain: "base",
  destChain: "solana",
  amountIn: 50_000_000n, // 50 USDC
  amountOutMin: 49_500_000n, // 0.5 USDC implied bridge fee
  estimatedFeeAtoms: 500_000n,
  etaSeconds: 60,
  fetchedAtMs: 1_700_000_000_000,
  ttlMs: 5 * 60 * 1000,
  depositAddress: "0xdeadbeef...",
  ...overrides,
});

test("quoteIsExpired returns false within TTL", () => {
  const q = baseQuote();
  // 4 minutes after fetch — still inside the 5-minute TTL.
  assert.equal(quoteIsExpired(q, q.fetchedAtMs + 4 * 60 * 1000), false);
});

test("quoteIsExpired returns true at exactly TTL", () => {
  const q = baseQuote();
  // Defensive: exactly TTL == expired (we don't want a quote firing
  // its last second after the upstream router already retracted it).
  assert.equal(quoteIsExpired(q, q.fetchedAtMs + q.ttlMs), true);
});

test("quoteIsExpired returns true past TTL", () => {
  const q = baseQuote();
  assert.equal(quoteIsExpired(q, q.fetchedAtMs + 10 * 60 * 1000), true);
});

test("pickCheapestQuote returns null on empty input", () => {
  assert.equal(pickCheapestQuote([]), null);
});

test("pickCheapestQuote picks the highest amountOutMin (lowest implicit fee)", () => {
  // For a fixed amountIn, "cheapest" = "user receives the most".
  const a = baseQuote({ provider: "squid", amountOutMin: 49_000_000n });
  const b = baseQuote({ provider: "mayan", amountOutMin: 49_500_000n });
  const c = baseQuote({ provider: "cctp", amountOutMin: 49_900_000n });
  assert.equal(pickCheapestQuote([a, b, c])?.provider, "cctp");
});

test("pickCheapestQuote ties broken by lower estimatedFeeAtoms", () => {
  // Two providers report identical amountOutMin but different fee
  // breakdowns. The one whose explicit fee is lower wins (more
  // reliable signal than the bridged-out estimate).
  const a = baseQuote({ provider: "mayan", estimatedFeeAtoms: 600_000n });
  const b = baseQuote({ provider: "squid", estimatedFeeAtoms: 400_000n });
  assert.equal(pickCheapestQuote([a, b])?.provider, "squid");
});

test("pickCheapestQuote ignores expired quotes", () => {
  const expired = baseQuote({
    provider: "squid",
    amountOutMin: 49_999_999n, // best amount, but stale
    ttlMs: 1, // immediate expiry
  });
  const fresh = baseQuote({
    provider: "mayan",
    amountOutMin: 49_500_000n,
  });
  // Pass a `nowMs` past the squid quote's expiry — squid drops out.
  assert.equal(
    pickCheapestQuote([expired, fresh], expired.fetchedAtMs + 1000)?.provider,
    "mayan",
  );
});

test("validateBridgeRoute accepts base → solana (allowed source → escrow)", () => {
  const r = validateBridgeRoute("base", "solana");
  assert.equal(r.ok, true);
});

test("validateBridgeRoute accepts solana → solana (no-op bridge, valid)", () => {
  // Same-chain "bridge" is just a transfer; should validate so the
  // dispatcher can short-circuit it without special-casing.
  const r = validateBridgeRoute("solana", "solana");
  assert.equal(r.ok, true);
});

test("validateBridgeRoute rejects bridging INTO base — base is not an escrow chain", () => {
  const r = validateBridgeRoute("solana", "base");
  assert.equal(r.ok, false);
  if (!r.ok) {
    // Error must mention base + the policy reason.
    const msg = r.reason.toLowerCase();
    assert.ok(msg.includes("base"), `reason should mention base: ${r.reason}`);
    assert.ok(
      msg.includes("escrow") || msg.includes("validator"),
      `reason should mention the policy: ${r.reason}`,
    );
  }
});

test("validateBridgeRoute rejects unknown source chain", () => {
  const r = validateBridgeRoute("ethereum", "solana");
  assert.equal(r.ok, false);
});

test("validateBridgeRoute rejects unknown dest chain", () => {
  const r = validateBridgeRoute("base", "polkadot");
  assert.equal(r.ok, false);
});
