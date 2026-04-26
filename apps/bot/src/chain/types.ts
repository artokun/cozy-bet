/**
 * Chain-agnostic adapter interface. Each chain (Solana, Base/EVM) implements
 * this surface so flows.ts doesn't care where a bet settles.
 *
 * Wallet addresses are passed as strings (base58 for Solana, 0x-hex for EVM).
 * Each adapter parses to its native type internally.
 *
 * Tx signatures are returned as strings (base58 for Solana, 0x-hex for EVM).
 */

export type Chain = "solana" | "base";

export interface OnChainBet {
  /** Mirror of the on-chain Bet account fields the bot needs to know about. */
  challenger: string;
  accepter: string;
  amount: bigint;
  challengerDeposited: boolean;
  accepterDeposited: boolean;
  status: "pending" | "funded" | "resolved" | "drawn" | "refunded";
  winner: string | null;
  termsHash: string; // hex (no 0x prefix)
}

export interface InitArgs {
  betId: bigint;
  amount: bigint;
  challenger: string;
  accepter: string;
  /** keccak256 hash of canonical terms; 32 bytes. */
  termsHash?: Uint8Array | number[] | null;
}

export interface ResolveArgs {
  betId: bigint;
  winner: string;
}

export interface DrawArgs {
  betId: bigint;
  challenger: string;
  accepter: string;
}

export interface RefundArgs {
  betId: bigint;
  challenger: string;
  accepter: string;
}

export interface SetFeeBpsArgs {
  betId: bigint;
  side: string;
  newBps: number;
}

export interface ChainAdapter {
  readonly chain: Chain;

  /** Resolver wallet address on this chain (base58 / 0x-hex). */
  readonly resolverAddress: string;

  /** Whether this adapter is configured + ready (env vars present, etc.). */
  readonly isConfigured: boolean;

  initializeBet(args: InitArgs): Promise<{ sig: string; betPda?: string; vaultPda?: string }>;
  resolve(args: ResolveArgs): Promise<string>;
  arbiterResolve(args: ResolveArgs): Promise<string>;
  draw(args: DrawArgs): Promise<string>;
  refund(args: RefundArgs): Promise<string>;
  setFeeBpsForSide(args: SetFeeBpsArgs): Promise<string>;
  fetchBet(betId: bigint): Promise<OnChainBet | null>;

  /** Build a chain-explorer URL for a given tx signature. */
  explorerTxUrl(sig: string): string;
}
