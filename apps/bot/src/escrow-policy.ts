/**
 * Chain-deployment policy.
 *
 * Two distinct sets:
 *
 *   ESCROW_CHAINS  — chains where the escrow CONTRACT can live. Funds
 *                    sit at rest in these contracts; the chain's
 *                    validator authority effectively has freeze power
 *                    over them.
 *
 *   SOURCE_CHAINS  — chains a user is allowed to deposit FROM. Funds
 *                    are only transient on these chains (just long
 *                    enough to bridge into an ESCROW_CHAINS contract),
 *                    so a freeze surface there is not a sustained risk.
 *
 * **Why Base is NOT in ESCROW_CHAINS.** Coinbase owns Base's validator
 * authority and has stated intent to freeze on-chain assets they
 * suspect of money-laundering. An escrow contract on Base could be
 * frozen without notice, locking participants' stakes indefinitely.
 * Solana and other non-operator-controlled L2s don't carry this risk
 * — no single entity can unilaterally censor a transaction.
 *
 * Base is fine as a SOURCE_CHAINS entry: the bridge tx (CCTP / Squid /
 * Mayan) takes ~1 min, and the funds are out of Base before they
 * present any sustained freeze surface.
 *
 * If you're tempted to add "base" to ESCROW_CHAINS, re-read this
 * comment + the message thread referenced in
 * apps/bot/src/escrow-policy.test.ts first.
 */

export const ESCROW_CHAINS = ["solana"] as const;
export type EscrowChain = (typeof ESCROW_CHAINS)[number];

export const SOURCE_CHAINS = ["solana", "base"] as const;
export type SourceChain = (typeof SOURCE_CHAINS)[number];

export function isEscrowChain(chain: string): chain is EscrowChain {
  return (ESCROW_CHAINS as readonly string[]).includes(chain);
}

export function isSourceChain(chain: string): chain is SourceChain {
  return (SOURCE_CHAINS as readonly string[]).includes(chain);
}

/**
 * Throws a self-describing error if the chain isn't an escrow chain.
 * The message intentionally cites the Coinbase / validator-authority
 * concern so a future engineer hitting it sees WHY, not just that.
 */
export function assertEscrowChain(chain: string): asserts chain is EscrowChain {
  if (!isEscrowChain(chain)) {
    throw new Error(
      `Chain "${chain}" is not an allowed escrow chain. ESCROW_CHAINS = ${JSON.stringify(
        ESCROW_CHAINS,
      )}. Base is intentionally excluded — Coinbase controls Base's validator authority and could freeze contract funds. Use a bridge (CCTP / Squid / Mayan) to ingest from Base into an allowed escrow chain instead.`,
    );
  }
}
