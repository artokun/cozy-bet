/**
 * Pure unit tests for x.ts. Covers parseTweetId across the URL shapes
 * users actually paste (twitter.com vs x.com, with/without www, query
 * strings, mobile prefix). The async fetch paths (fetchTweet,
 * verifyShareTweet) hit Discord/X — left for an integration test
 * harness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTweetId } from "./x.js";

test("parseTweetId accepts x.com tweets", () => {
  assert.equal(
    parseTweetId("https://x.com/anyuser/status/1234567890123456789"),
    "1234567890123456789",
  );
  assert.equal(
    parseTweetId("http://x.com/anyuser/status/9999"),
    "9999",
  );
});

test("parseTweetId accepts twitter.com tweets (legacy domain)", () => {
  assert.equal(
    parseTweetId("https://twitter.com/anyuser/status/123"),
    "123",
  );
});

test("parseTweetId accepts trailing query strings + paths", () => {
  assert.equal(
    parseTweetId(
      "https://x.com/u/status/12345?ref_src=twsrc%5Etfw&t=abc",
    ),
    "12345",
  );
  // Photo / video sub-paths after status ID are common.
  assert.equal(
    parseTweetId("https://x.com/u/status/67890/photo/1"),
    "67890",
  );
});

test("parseTweetId case-insensitive on the host segment", () => {
  // Some mobile shares uppercase parts of the URL.
  assert.equal(
    parseTweetId("https://X.COM/User/status/42"),
    "42",
  );
});

test("parseTweetId rejects non-tweet URLs", () => {
  assert.equal(parseTweetId("https://x.com/anyuser"), null);
  assert.equal(parseTweetId("https://x.com/anyuser/lists/foo"), null);
  assert.equal(parseTweetId("https://example.com/status/123"), null);
  assert.equal(parseTweetId("not-a-url"), null);
  assert.equal(parseTweetId(""), null);
});

test("parseTweetId rejects status URL with non-numeric ID", () => {
  assert.equal(parseTweetId("https://x.com/u/status/abc"), null);
});
