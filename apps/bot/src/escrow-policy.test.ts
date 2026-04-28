/**
 * Codifies the chain-deployment policy decision:
 *
 *   The escrow contract MUST NOT live on Base, because Coinbase
 *   controls Base's validator authority and could freeze contract
 *   funds if they flag the activity. Base is allowed as a *source*
 *   chain (users deposit USDC from Base) only because bridge
 *   transactions don't sit in Coinbase's freeze surface — funds are
 *   only on Base in transit.
 *
 *   Escrow lives on chains where validator authority is decentralized:
 *   Solana for the Anchor program, and any future EVM L2 that isn't
 *   operator-controlled.
 *
 * If you find yourself wanting to add "base" to ESCROW_CHAINS, re-read
 * docs/positioning.md and the convo that produced this policy first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESCROW_CHAINS,
  SOURCE_CHAINS,
  isEscrowChain,
  isSourceChain,
  assertEscrowChain,
} from "./escrow-policy.js";

test("ESCROW_CHAINS includes solana", () => {
  assert.equal(ESCROW_CHAINS.includes("solana"), true);
});

test("ESCROW_CHAINS does NOT include base — Coinbase validator-authority risk", () => {
  // This assertion is load-bearing. Don't relax it without re-reading
  // the policy comment at the top of escrow-policy.ts.
  assert.equal(ESCROW_CHAINS.includes("base" as never), false);
});

test("SOURCE_CHAINS is a strict superset of ESCROW_CHAINS", () => {
  for (const c of ESCROW_CHAINS) {
    assert.equal(
      SOURCE_CHAINS.includes(c),
      true,
      `${c} is in ESCROW_CHAINS but not SOURCE_CHAINS`,
    );
  }
});

test("SOURCE_CHAINS includes base — base is allowed as a deposit source via bridge", () => {
  assert.equal(SOURCE_CHAINS.includes("base"), true);
});

test("isEscrowChain narrows correctly", () => {
  assert.equal(isEscrowChain("solana"), true);
  assert.equal(isEscrowChain("base"), false);
  assert.equal(isEscrowChain("ethereum"), false);
  assert.equal(isEscrowChain(""), false);
  assert.equal(isEscrowChain("SOLANA"), false); // case-sensitive
});

test("isSourceChain accepts both escrow + bridge-source chains", () => {
  assert.equal(isSourceChain("solana"), true);
  assert.equal(isSourceChain("base"), true);
  assert.equal(isSourceChain("ethereum"), false);
});

test("assertEscrowChain throws a labelled error for non-escrow chains", () => {
  assert.throws(
    () => assertEscrowChain("base"),
    (err: Error) => {
      // Error message must mention WHY base isn't allowed, not just that
      // it isn't — so the call-site error doesn't lead a future
      // engineer to silently widen the policy.
      const msg = err.message.toLowerCase();
      return (
        msg.includes("base") &&
        (msg.includes("validator") ||
          msg.includes("coinbase") ||
          msg.includes("freeze"))
      );
    },
  );
});

test("assertEscrowChain accepts solana silently", () => {
  assert.doesNotThrow(() => assertEscrowChain("solana"));
});
