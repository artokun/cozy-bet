import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEvmAddress,
  isEvmPrivateKey,
  looksLikeSolanaBase58,
} from "./env-shape.js";

test("isEvmAddress accepts standard 0x addresses (any case)", () => {
  assert.equal(isEvmAddress("0xffcC554C4157B9363ab561237e3cc02626775F71"), true);
  assert.equal(
    isEvmAddress("0xffcc554c4157b9363ab561237e3cc02626775f71"),
    true,
  );
  assert.equal(
    isEvmAddress("0xFFCC554C4157B9363AB561237E3CC02626775F71"),
    true,
  );
});

test("isEvmAddress rejects wrong-length / missing-prefix", () => {
  assert.equal(isEvmAddress(""), false);
  assert.equal(isEvmAddress("0x"), false);
  // Missing 0x.
  assert.equal(
    isEvmAddress("ffcC554C4157B9363ab561237e3cc02626775F71"),
    false,
  );
  // Off by one.
  assert.equal(
    isEvmAddress("0xffcC554C4157B9363ab561237e3cc02626775F7"),
    false,
  );
  assert.equal(
    isEvmAddress("0xffcC554C4157B9363ab561237e3cc02626775F711"),
    false,
  );
  // Non-hex.
  assert.equal(
    isEvmAddress("0xffcC554C4157B9363ab561237e3cc02626775FZZ"),
    false,
  );
});

test("isEvmPrivateKey accepts 0x + 64 hex chars", () => {
  const ok = "0x" + "a".repeat(64);
  assert.equal(isEvmPrivateKey(ok), true);
  assert.equal(
    isEvmPrivateKey("0xAA" + "00".repeat(31)),
    true,
  );
});

test("isEvmPrivateKey rejects wrong-length", () => {
  assert.equal(isEvmPrivateKey(""), false);
  assert.equal(isEvmPrivateKey("0xab"), false);
  assert.equal(isEvmPrivateKey("0x" + "a".repeat(63)), false);
  assert.equal(isEvmPrivateKey("0x" + "a".repeat(65)), false);
  // Missing prefix.
  assert.equal(isEvmPrivateKey("a".repeat(64)), false);
});

test("looksLikeSolanaBase58 accepts deployed treasury addresses", () => {
  // Real values from .env.example (devnet).
  assert.equal(
    looksLikeSolanaBase58("8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7iS"),
    true,
  );
  assert.equal(
    looksLikeSolanaBase58("BibcQ6GJ44J5oV8dJYqdZU51kwK5TVxSnZmZ6xHUzcJ7"),
    true,
  );
});

test("looksLikeSolanaBase58 rejects EVM addresses (the common mistake)", () => {
  // Critical: 0x... addresses must NOT be misclassified as Solana so the
  // smoke check's chain-direction hint fires correctly.
  assert.equal(
    looksLikeSolanaBase58("0xffcC554C4157B9363ab561237e3cc02626775F71"),
    false,
  );
  assert.equal(
    looksLikeSolanaBase58("0x131867e52d0c0c745758254E6F83f4beE4Cb10E9"),
    false,
  );
});

test("looksLikeSolanaBase58 rejects illegal characters", () => {
  // The Bitcoin base58 alphabet excludes 0, O, I, l — these strings
  // include forbidden chars and should be rejected.
  assert.equal(looksLikeSolanaBase58("0".repeat(40)), false); // contains 0
  assert.equal(
    looksLikeSolanaBase58("8RXZkT1KV3MmCMy1QwAT6bGD6Jzdg7LQGoHLKXDdL7Il"),
    false, // contains I + l
  );
});

test("looksLikeSolanaBase58 rejects too-short / too-long", () => {
  assert.equal(looksLikeSolanaBase58(""), false);
  assert.equal(looksLikeSolanaBase58("a".repeat(31)), false);
  assert.equal(looksLikeSolanaBase58("a".repeat(45)), false);
});
