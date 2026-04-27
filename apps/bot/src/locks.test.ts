import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLockSentinel,
  isLockStale,
  lockAcquiredAt,
} from "./locks.js";

const MIN = 60_000;
const STALE = 5 * MIN;

test("formatLockSentinel embeds reason + timestamp", () => {
  assert.equal(formatLockSentinel("resolve", 1234), "PENDING:resolve:1234");
  assert.equal(
    formatLockSentinel("initialize", 0),
    "PENDING:initialize:0",
  );
});

test("lockAcquiredAt round-trips with formatLockSentinel", () => {
  const now = Date.now();
  const s = formatLockSentinel("resolve", now);
  assert.equal(lockAcquiredAt(s), now);
});

test("lockAcquiredAt returns null for non-PENDING values", () => {
  assert.equal(lockAcquiredAt(null), null);
  assert.equal(lockAcquiredAt(""), null);
  // A real tx sig must not be misread as a sentinel.
  assert.equal(lockAcquiredAt("5VfYd...realtxsig"), null);
});

test("lockAcquiredAt returns null for legacy sentinel (no timestamp)", () => {
  // Pre-format-change sentinels — single colon after PENDING.
  assert.equal(lockAcquiredAt("PENDING:resolve"), null);
  assert.equal(lockAcquiredAt("PENDING:initialize"), null);
});

test("lockAcquiredAt handles reasons with colons (e.g. URLs)", () => {
  // applyShareDiscount uses the tweet URL as the reason; URLs contain
  // `https://` so the sentinel has multiple colons. Parser must use the
  // *last* colon to find the timestamp.
  const url = "https://x.com/foo/status/123";
  const s = formatLockSentinel(url, 999_888);
  assert.equal(s, `PENDING:${url}:999888`);
  assert.equal(lockAcquiredAt(s), 999_888);
});

test("lockAcquiredAt rejects malformed timestamps", () => {
  assert.equal(lockAcquiredAt("PENDING:resolve:not-a-number"), null);
  assert.equal(lockAcquiredAt("PENDING:resolve:-1"), null);
  assert.equal(lockAcquiredAt("PENDING:resolve:0"), null);
});

test("isLockStale returns false for null / non-sentinel", () => {
  const now = Date.now();
  assert.equal(isLockStale(null, now, STALE), false);
  assert.equal(isLockStale("realtxsig", now, STALE), false);
});

test("isLockStale returns false for fresh lock", () => {
  const now = Date.now();
  const fresh = formatLockSentinel("resolve", now - MIN);
  assert.equal(isLockStale(fresh, now, STALE), false);
});

test("isLockStale returns true for stuck lock", () => {
  const now = Date.now();
  const stuck = formatLockSentinel("resolve", now - 10 * MIN);
  assert.equal(isLockStale(stuck, now, STALE), true);
});

test("isLockStale returns true for legacy sentinel (no timestamp)", () => {
  // Worst case: clears a just-acquired legacy lock mid-deploy, user
  // retries — same UX as a chain RPC timeout.
  const now = Date.now();
  assert.equal(isLockStale("PENDING:resolve", now, STALE), true);
});

test("isLockStale boundary: exactly staleMs is not yet stale", () => {
  const now = Date.now();
  const atBoundary = formatLockSentinel("resolve", now - STALE);
  assert.equal(isLockStale(atBoundary, now, STALE), false);
  const justPast = formatLockSentinel("resolve", now - STALE - 1);
  assert.equal(isLockStale(justPast, now, STALE), true);
});
