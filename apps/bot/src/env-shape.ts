/**
 * Pure predicates for validating env var shapes before they're handed to
 * a chain SDK. Used by:
 *
 *   - apps/bot/src/solana.ts envPubkey() — Solana base58 pubkey
 *   - apps/bot/src/evm.ts envEvmAddress() — 0x EVM address
 *   - apps/bot/src/evm.ts envEvmPrivateKey() — 0x 64-hex private key
 *   - scripts/testnet-smoke.ts — env-vs-expected consistency check
 *
 * No imports — testable in isolation.
 */

/** EVM address: 0x followed by exactly 40 hex chars, case-insensitive. */
export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(s);
}

/** EVM private key: 0x followed by exactly 64 hex chars (32 bytes). */
export function isEvmPrivateKey(s: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(s);
}

/**
 * Solana base58: Bitcoin-style alphabet (no 0/O/I/l), length 32–44.
 *
 * NOT a definitive check (the public key constructor is the real
 * validation — this is a *shape* check used to give better error
 * messages when someone pastes an EVM 0x... into a Solana env slot).
 *
 * The trailing `&& !isEvmAddress` guard catches the most common
 * confusion: 0x4Ed9... happens to satisfy [1-9A-HJ-NP-Za-km-z]{40}.
 */
export function looksLikeSolanaBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !isEvmAddress(s);
}
