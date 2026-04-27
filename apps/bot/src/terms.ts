/**
 * keccak256 of a bet's canonical sentence (UTF-8 bytes) — the value
 * committed on-chain as `initialize_bet`'s `terms_hash` arg. Both parties
 * EIP-712-sign the same canonical sentence off-chain, so a matching hash
 * proves the contract binding matches what they agreed to.
 *
 * Lives in its own tiny file (rather than llm.ts) so importing it for
 * tests doesn't drag in the @anthropic-ai/sdk client + env validation.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

export function termsHashOf(canonical: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(canonical));
}

export function termsHashHex(canonical: string): string {
  return Array.from(termsHashOf(canonical))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
