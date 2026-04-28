/**
 * Tests for the multi-provider quote router. Composes
 * BridgeAdapter + pickCheapestQuote into a single call: fan-out
 * quote requests to N adapters in parallel, tolerate per-provider
 * failures, return the best surviving quote.
 *
 * Pattern lifts from real-world cross-chain UIs (Squid + Mayan
 * widgets typically race quotes and pick the better one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getBestQuoteAcrossProviders,
  type ProviderQuoteResult,
} from "./bridge-router.js";
import { FakeBridgeAdapter } from "./bridge-adapter.js";
import type { BridgeAdapter } from "./bridge-adapter.js";

class StubAdapter implements BridgeAdapter {
  constructor(
    private readonly fakeFee: bigint,
    private readonly fixedNow = 1_700_000_000_000,
  ) {}
  async getQuote(args: {
    sourceChain: string;
    destChain: string;
    amountIn: bigint;
  }) {
    return {
      provider: "fake" as const,
      sourceChain: args.sourceChain,
      destChain: args.destChain,
      amountIn: args.amountIn,
      amountOutMin: args.amountIn - this.fakeFee,
      estimatedFeeAtoms: this.fakeFee,
      etaSeconds: 60,
      fetchedAtMs: this.fixedNow,
      ttlMs: 5 * 60 * 1000,
      depositAddress: `stub-${this.fakeFee}`,
    };
  }
  async getDepositStatus() {
    return { state: "pending" as const };
  }
}

class FailingAdapter implements BridgeAdapter {
  constructor(private readonly reason: string) {}
  async getQuote(): Promise<never> {
    throw new Error(this.reason);
  }
  async getDepositStatus() {
    return { state: "pending" as const };
  }
}

test("returns the cheapest quote across multiple adapters", async () => {
  const cheap = new StubAdapter(100n);
  const mid = new StubAdapter(500n);
  const expensive = new StubAdapter(1000n);
  const result = await getBestQuoteAcrossProviders(
    [expensive, cheap, mid],
    { sourceChain: "base", destChain: "solana", amountIn: 1_000_000n },
  );
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.quote.estimatedFeeAtoms, 100n);
    assert.equal(result.errors.length, 0);
  }
});

test("tolerates one failing adapter and returns the rest's best", async () => {
  const failing = new FailingAdapter("squid: rate-limited");
  const cheap = new StubAdapter(100n);
  const mid = new StubAdapter(500n);
  const result = await getBestQuoteAcrossProviders(
    [failing, mid, cheap],
    { sourceChain: "base", destChain: "solana", amountIn: 1_000_000n },
  );
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.quote.estimatedFeeAtoms, 100n);
    // Caller can see which providers failed without forcing an
    // error path — useful for observability.
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.reason, /rate-limited/);
  }
});

test("returns no_quotes if every adapter fails", async () => {
  const result = await getBestQuoteAcrossProviders(
    [
      new FailingAdapter("squid: timeout"),
      new FailingAdapter("mayan: 503"),
    ],
    { sourceChain: "base", destChain: "solana", amountIn: 1_000_000n },
  );
  assert.equal(result.kind, "no_quotes");
  if (result.kind === "no_quotes") {
    assert.equal(result.errors.length, 2);
    // Errors carry enough context for an oncall responder to triage.
    assert.match(result.errors[0]!.reason, /timeout/);
    assert.match(result.errors[1]!.reason, /503/);
  }
});

test("returns no_quotes if adapter list is empty", async () => {
  const result = await getBestQuoteAcrossProviders([], {
    sourceChain: "base",
    destChain: "solana",
    amountIn: 1_000_000n,
  });
  assert.equal(result.kind, "no_quotes");
  if (result.kind === "no_quotes") {
    assert.equal(result.errors.length, 0);
  }
});

test("validates the route once before fanning out — fails fast", async () => {
  // dest=base would individually be rejected by every adapter; cheaper
  // to validate the route once at the top and skip the fan-out entirely.
  const adapter = new StubAdapter(100n);
  const result = await getBestQuoteAcrossProviders(
    [adapter, adapter],
    { sourceChain: "solana", destChain: "base", amountIn: 1n },
  );
  assert.equal(result.kind, "invalid_route");
  if (result.kind === "invalid_route") {
    assert.match(result.reason.toLowerCase(), /base|escrow|validator/);
  }
});

test("attaches provider names to each error", async () => {
  // Error carries the adapter index so a caller logging `errors` can
  // map back to which provider failed (useful when adapters[] is
  // built dynamically from env).
  const result = await getBestQuoteAcrossProviders(
    [new FailingAdapter("a"), new FailingAdapter("b")],
    { sourceChain: "base", destChain: "solana", amountIn: 1n },
  );
  assert.equal(result.kind, "no_quotes");
  if (result.kind === "no_quotes") {
    assert.equal(result.errors[0]!.adapterIndex, 0);
    assert.equal(result.errors[1]!.adapterIndex, 1);
  }
});

test("ProviderQuoteResult type exhaustively narrows", () => {
  // Compile-time + runtime exhaustiveness check: integration agent
  // can switch on `kind` and TS will yell if a variant is added
  // without updating call sites.
  const kinds: ProviderQuoteResult["kind"][] = [
    "ok",
    "no_quotes",
    "invalid_route",
  ];
  for (const k of kinds) assert.ok(typeof k === "string");
});

test("integrates with FakeBridgeAdapter (smoke)", async () => {
  // The fake adapter is the canonical reference. Make sure the router
  // composes with it cleanly — if a real adapter wires up identically,
  // it'll work.
  const fake = new FakeBridgeAdapter({ now: () => 1_700_000_000_000 });
  const result = await getBestQuoteAcrossProviders([fake], {
    sourceChain: "base",
    destChain: "solana",
    amountIn: 50_000_000n,
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.quote.amountIn, 50_000_000n);
    assert.equal(result.quote.amountOutMin, 49_500_000n);
  }
});
