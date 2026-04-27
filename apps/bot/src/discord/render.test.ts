/**
 * Pure unit tests for the value-formatting helpers in render.ts.
 * formatAmount is used everywhere user-facing (bet cards, status,
 * leaderboard, watchdog DMs) so getting it wrong silently mis-states
 * everyone's stake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount } from "./render.js";

test("formatAmount converts USDC atoms (6dec) to fixed-2 decimal string", () => {
  assert.equal(formatAmount(0n), "0.00");
  assert.equal(formatAmount(1n), "0.00"); // sub-cent rounds away
  assert.equal(formatAmount(10_000n), "0.01");
  assert.equal(formatAmount(1_000_000n), "1.00");
  assert.equal(formatAmount(50_000_000n), "50.00");
  assert.equal(formatAmount(100_000_000n), "100.00"); // arbiter min fee
  assert.equal(formatAmount(123_450_000n), "123.45");
});

test("formatAmount rounds via Number(...).toFixed(2) — float quirks visible", () => {
  // Lock in observed behavior so a future formatter swap is intentional:
  assert.equal(formatAmount(123_456n), "0.12"); // 0.123456 → "0.12"
  assert.equal(formatAmount(125_000n), "0.13"); // 0.125 → "0.13"
  // 1.005 in IEEE-754 is actually 1.00499999... so toFixed gives "1.00",
  // NOT "1.01". This is a known JS float quirk; if penny-accurate
  // accounting becomes load-bearing (e.g. fee math UI), swap to a
  // bigint-only formatter that doesn't round-trip through Number.
  assert.equal(formatAmount(1_005_000n), "1.00");
});

test("formatAmount handles negative values (refund accounting)", () => {
  // A refund event might temporarily produce a negative balance delta;
  // make sure the formatter doesn't blow up.
  assert.equal(formatAmount(-1_000_000n), "-1.00");
  assert.equal(formatAmount(-50_000_000n), "-50.00");
});

test("formatAmount stays accurate up to ~1 trillion USDC", () => {
  // We hit Number precision loss around 2^53 atoms (~9 trillion USDC).
  // Below 1T USDC the conversion is exact in the user-facing 2-decimal
  // representation. Spot-check a large but realistic upper bound.
  const oneTrillionUsdcAtoms = 1_000_000_000_000n * 1_000_000n; // 1e18
  // Number(1e18)/1e6 = 1e12 — exact at this magnitude.
  assert.equal(formatAmount(oneTrillionUsdcAtoms), "1000000000000.00");
});
