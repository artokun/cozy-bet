/**
 * Tests for withRetry — exponential-backoff wrapper for transient
 * failures. Useful for the bridge-adapter layer: Squid rate-limits
 * pretty aggressively and Mayan returns 5xxs under load. The
 * integration agent wraps adapter.getQuote in withRetry and gets
 * "tolerate transient blips" for free.
 *
 * Uses an injectable delay so tests don't actually wait — exponential
 * backoff is verified by inspecting the delay-call arguments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "./retry.js";

test("returns success on the first attempt", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 10, delay: async () => {} },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retries on transient failure and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("rate-limited (429)");
      return "ok";
    },
    {
      maxAttempts: 5,
      baseDelayMs: 10,
      isRetryable: (e) => /rate-limited/.test(e.message),
      delay: async () => {},
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("throws after maxAttempts when error is retryable but persistent", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("503 service unavailable");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetryable: () => true,
        delay: async () => {},
      },
    ),
    /503/,
  );
  assert.equal(calls, 3);
});

test("does NOT retry on non-retryable error — fails fast", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("invalid signature");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        // Only retry rate-limits/5xxs; signature errors are programmer bugs.
        isRetryable: (e) => /429|503|timeout/.test(e.message),
        delay: async () => {},
      },
    ),
    /invalid signature/,
  );
  assert.equal(calls, 1);
});

test("uses exponential backoff (1×, 2×, 4× baseDelayMs)", async () => {
  const delays: number[] = [];
  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("transient");
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        isRetryable: () => true,
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    ),
  );
  // After attempts 1, 2, 3 we sleep before retrying. After attempt 4
  // we throw — no final sleep. So 3 delays: 100, 200, 400.
  assert.deepEqual(delays, [100, 200, 400]);
});

test("caps backoff at maxDelayMs", async () => {
  const delays: number[] = [];
  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("transient");
      },
      {
        maxAttempts: 6,
        baseDelayMs: 100,
        maxDelayMs: 350,
        isRetryable: () => true,
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    ),
  );
  // Pre-cap: 100, 200, 400, 800, 1600 → after cap: 100, 200, 350, 350, 350.
  assert.deepEqual(delays, [100, 200, 350, 350, 350]);
});

test("honors AbortSignal mid-retry — throws aborted error", async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        if (calls === 2) ac.abort();
        throw new Error("transient");
      },
      {
        maxAttempts: 10,
        baseDelayMs: 1,
        isRetryable: () => true,
        signal: ac.signal,
        delay: async () => {},
      },
    ),
    (err: Error) => /abort/i.test(err.message) || err.name === "AbortError",
  );
  // Should stop ~immediately after abort, not keep retrying.
  assert.ok(calls <= 3, `expected <=3 attempts, got ${calls}`);
});

test("default isRetryable retries on common transient signals", async () => {
  // When isRetryable is omitted, retry on /429|503|504|timeout|ECONN/i.
  const transientReasons = [
    "429 too many requests",
    "503 service unavailable",
    "504 gateway timeout",
    "timeout exceeded",
    "ECONNRESET",
  ];
  for (const reason of transientReasons) {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(reason);
        },
        { maxAttempts: 2, baseDelayMs: 1, delay: async () => {} },
      ),
    );
    assert.equal(
      calls,
      2,
      `default isRetryable should retry on "${reason}" (got ${calls} calls)`,
    );
  }
});

test("default isRetryable does NOT retry on programmer errors", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new TypeError("Cannot read property 'foo' of undefined");
      },
      { maxAttempts: 5, baseDelayMs: 1, delay: async () => {} },
    ),
  );
  assert.equal(calls, 1);
});
