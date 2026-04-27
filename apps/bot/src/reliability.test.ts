import { test } from "node:test";
import assert from "node:assert/strict";
import { isOnTimeResolution } from "./reliability.js";

const ONE_HOUR = 60 * 60 * 1000;

test("isOnTimeResolution treats null deadline as on-time", () => {
  // Legacy bets that predate the deadline column. Reliability counter
  // counts them as on-time so old users aren't penalized.
  assert.equal(isOnTimeResolution(new Date(), null), true);
  assert.equal(isOnTimeResolution(new Date(), undefined), true);
});

test("isOnTimeResolution accepts resolutions within ±24h of deadline", () => {
  const deadline = new Date("2026-04-27T12:00:00Z");
  // Right at deadline.
  assert.equal(isOnTimeResolution(deadline, deadline), true);
  // 23h after.
  assert.equal(
    isOnTimeResolution(new Date(deadline.getTime() + 23 * ONE_HOUR), deadline),
    true,
  );
  // 23h before (e.g. game ended early — rare but valid).
  assert.equal(
    isOnTimeResolution(new Date(deadline.getTime() - 23 * ONE_HOUR), deadline),
    true,
  );
});

test("isOnTimeResolution accepts the exact 24h boundary", () => {
  const deadline = new Date("2026-04-27T12:00:00Z");
  assert.equal(
    isOnTimeResolution(new Date(deadline.getTime() + 24 * ONE_HOUR), deadline),
    true,
  );
  assert.equal(
    isOnTimeResolution(new Date(deadline.getTime() - 24 * ONE_HOUR), deadline),
    true,
  );
});

test("isOnTimeResolution rejects resolutions outside the 24h window", () => {
  const deadline = new Date("2026-04-27T12:00:00Z");
  // Just past 24h.
  assert.equal(
    isOnTimeResolution(
      new Date(deadline.getTime() + 24 * ONE_HOUR + 1000),
      deadline,
    ),
    false,
  );
  // Multiple days late.
  assert.equal(
    isOnTimeResolution(
      new Date(deadline.getTime() + 7 * 24 * ONE_HOUR),
      deadline,
    ),
    false,
  );
  // Way before.
  assert.equal(
    isOnTimeResolution(
      new Date(deadline.getTime() - 7 * 24 * ONE_HOUR),
      deadline,
    ),
    false,
  );
});
