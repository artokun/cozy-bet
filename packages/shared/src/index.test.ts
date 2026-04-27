/**
 * Pure unit tests for the shared utility helpers. Run via
 * `pnpm --filter @cozy-bet/shared test`.
 *
 * The PDA helpers (findConfigPda / findBetPda / findVaultPda) call into
 * @solana/web3.js's findProgramAddressSync which is a real SDK function;
 * we don't mock it. These tests cover the JS-only helpers
 * (makeShortcode, isShortcode, makeBetId, BetStatus).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BetStatus,
  isShortcode,
  makeBetId,
  makeShortcode,
} from "./index.js";

const SHORTCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

test("makeShortcode default length is 6", () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(makeShortcode().length, 6);
  }
});

test("makeShortcode honors custom length", () => {
  assert.equal(makeShortcode(4).length, 4);
  assert.equal(makeShortcode(10).length, 10);
});

test("makeShortcode uses the human-safe alphabet (no 0/1/I/L/O/U)", () => {
  const banned = new Set(["0", "1", "I", "L", "O", "U"]);
  for (let i = 0; i < 200; i++) {
    const code = makeShortcode(8);
    for (const ch of code) {
      assert.ok(
        SHORTCODE_ALPHABET.includes(ch),
        `${ch} not in alphabet (code: ${code})`,
      );
      assert.ok(!banned.has(ch), `${ch} is banned (code: ${code})`);
    }
  }
});

test("isShortcode accepts canonical 6-char codes", () => {
  assert.equal(isShortcode("K7M2RX"), true);
  assert.equal(isShortcode("ABCDEF"), true);
  assert.equal(isShortcode("23456789"), false); // all-digits is a bet id
  assert.equal(isShortcode("abc23x"), true); // case-insensitive
});

test("isShortcode rejects all-digit strings (those are bet ids)", () => {
  assert.equal(isShortcode("123"), false);
  assert.equal(isShortcode("12345"), false);
  assert.equal(
    isShortcode("99999999999999999999"),
    false,
    "long bigint bet id",
  );
});

test("isShortcode rejects malformed input", () => {
  assert.equal(isShortcode(""), false);
  assert.equal(isShortcode("abc"), false); // too short (< 4)
  assert.equal(isShortcode("ABCDEFGHI"), false); // too long (> 8)
  assert.equal(isShortcode("ABC-DE"), false); // illegal character
  assert.equal(isShortcode("ABC DE"), false); // space
  assert.equal(isShortcode("ABC.DE"), false); // punctuation
});

test("makeBetId returns a BN that fits in u64", () => {
  const TWO_TO_64 = 1n << 64n;
  for (let i = 0; i < 100; i++) {
    const id = makeBetId();
    const asBig = BigInt(id.toString());
    assert.ok(asBig >= 0n, "non-negative");
    assert.ok(asBig < TWO_TO_64, "fits in u64");
  }
});

test("makeBetId is sufficiently unique under tight loops", () => {
  // 12 bits of randomness per ms — collisions within a single ms are
  // possible (1 in 4096) but two distinct calls a few ms apart should
  // virtually never collide.
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) seen.add(makeBetId().toString());
  // Allow a couple of collisions for paranoia, but most should be unique.
  assert.ok(seen.size > 90, `expected mostly-unique IDs, got ${seen.size}/100`);
});

test("BetStatus enum covers the documented lifecycle", () => {
  const expected = [
    "proposed",
    "accepted",
    "pending",
    "funded",
    "resolved",
    "drawn",
    "refunded",
    "canceled",
    "disputed",
  ];
  for (const status of expected) {
    assert.ok(
      Object.values(BetStatus).includes(status as BetStatus),
      `missing ${status}`,
    );
  }
});
