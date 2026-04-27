import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsdcAtoms } from "./format.js";

test("formatUsdcAtoms accepts bigint, string, and number", () => {
  assert.equal(formatUsdcAtoms(50_000_000n), "50.00");
  assert.equal(formatUsdcAtoms("50000000"), "50.00");
  assert.equal(formatUsdcAtoms(50_000_000), "50.00");
});

test("formatUsdcAtoms scales 6dec correctly", () => {
  assert.equal(formatUsdcAtoms(0n), "0.00");
  assert.equal(formatUsdcAtoms(1_000_000n), "1.00");
  assert.equal(formatUsdcAtoms(123_450_000n), "123.45");
});

test("formatUsdcAtoms matches the bot's render.formatAmount on shared inputs", () => {
  // Mirror the bot side's expectations from
  // apps/bot/src/discord/render.test.ts so divergence is caught here too.
  assert.equal(formatUsdcAtoms(0n), "0.00");
  assert.equal(formatUsdcAtoms(10_000n), "0.01");
  assert.equal(formatUsdcAtoms(100_000_000n), "100.00");
  assert.equal(formatUsdcAtoms(-1_000_000n), "-1.00");
});
