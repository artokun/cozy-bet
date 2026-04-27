import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseExplorerTxUrl,
  explorerTxUrlFor,
  isRealTxSig,
  solanaExplorerTxUrl,
} from "./explorer.js";

test("solanaExplorerTxUrl includes cluster on devnet/testnet", () => {
  assert.equal(
    solanaExplorerTxUrl("devnet", "abc123"),
    "https://explorer.solana.com/tx/abc123?cluster=devnet",
  );
  assert.equal(
    solanaExplorerTxUrl("testnet", "abc123"),
    "https://explorer.solana.com/tx/abc123?cluster=testnet",
  );
});

test("solanaExplorerTxUrl omits cluster on mainnet-beta", () => {
  // Solana Explorer treats mainnet as the default; including ?cluster=mainnet-beta
  // works but is non-canonical. Match the canonical form.
  assert.equal(
    solanaExplorerTxUrl("mainnet-beta", "abc123"),
    "https://explorer.solana.com/tx/abc123",
  );
});

test("baseExplorerTxUrl picks basescan host by network", () => {
  assert.equal(
    baseExplorerTxUrl("base", "0xabc"),
    "https://basescan.org/tx/0xabc",
  );
  assert.equal(
    baseExplorerTxUrl("base-sepolia", "0xabc"),
    "https://sepolia.basescan.org/tx/0xabc",
  );
});

test("explorerTxUrlFor dispatches by chain", () => {
  assert.equal(
    explorerTxUrlFor("solana", "devnet", "base-sepolia", "sig"),
    "https://explorer.solana.com/tx/sig?cluster=devnet",
  );
  assert.equal(
    explorerTxUrlFor("base", "devnet", "base-sepolia", "0xsig"),
    "https://sepolia.basescan.org/tx/0xsig",
  );
});

test("isRealTxSig accepts real-looking sigs", () => {
  // Solana base58.
  assert.equal(
    isRealTxSig("2RFA26AxvycTLCipevqTtfai4etjFBpbTDRrPkfqgRWnb4N48ce1Vg8Dm9fhXJyxMpYd5PffmndQuim6Y3Lg6Yem"),
    true,
  );
  // EVM 0x.
  assert.equal(
    isRealTxSig(
      "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd",
    ),
    true,
  );
  // Even a short non-PENDING value is "real" for display purposes —
  // the helper's job is just to gate out the lock sentinel.
  assert.equal(isRealTxSig("anything"), true);
});

test("isRealTxSig rejects PENDING:* lock sentinels", () => {
  assert.equal(isRealTxSig("PENDING:resolve"), false);
  assert.equal(isRealTxSig("PENDING:draw"), false);
  assert.equal(isRealTxSig("PENDING:refund"), false);
  assert.equal(isRealTxSig("PENDING:arbiter-decide"), false);
  assert.equal(isRealTxSig("PENDING:initialize"), false);
  // Including the share-discount form (URL appended).
  assert.equal(
    isRealTxSig("PENDING:https://x.com/u/status/12345"),
    false,
  );
});

test("isRealTxSig rejects null/undefined/empty", () => {
  assert.equal(isRealTxSig(null), false);
  assert.equal(isRealTxSig(undefined), false);
  assert.equal(isRealTxSig(""), false);
});
