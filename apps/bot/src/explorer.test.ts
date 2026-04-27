import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseExplorerTxUrl,
  explorerTxUrlFor,
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
