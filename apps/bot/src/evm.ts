/**
 * EVM (Base) chain adapter. Mirrors apps/bot/src/solana.ts's surface so
 * apps/bot/src/chain.ts can dispatch by bet.chain transparently.
 *
 * Uses viem for RPC + signing. Resolver private key from RESOLVER_PRIVATE_KEY
 * env. Treasury addresses from EVM_TREASURY_OWNER_1..4.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base as baseMainnet } from "viem/chains";
import { env } from "./env.js";

// Addresses configured at module load. Throwing here would crash at import,
// so we lazy-error in `assertConfigured()` when an EVM bet is actually used.
const RESOLVER_PRIVATE_KEY = env.RESOLVER_PRIVATE_KEY;
const ESCROW_ADDRESS = env.EVM_ESCROW_ADDRESS;
const USDC_ADDRESS = env.EVM_USDC_ADDRESS;
const TREASURY_OWNERS: Address[] = [
  env.EVM_TREASURY_OWNER_1 as Address,
  env.EVM_TREASURY_OWNER_2 as Address,
  env.EVM_TREASURY_OWNER_3 as Address,
  env.EVM_TREASURY_OWNER_4 as Address,
];
const CHAIN = env.EVM_NETWORK === "base" ? baseMainnet : baseSepolia;

export const isConfigured = Boolean(
  RESOLVER_PRIVATE_KEY &&
    ESCROW_ADDRESS &&
    USDC_ADDRESS &&
    TREASURY_OWNERS.every((a) => a),
);

function assertConfigured(): void {
  if (!isConfigured) {
    throw new Error(
      "EVM adapter not configured — set RESOLVER_PRIVATE_KEY, EVM_ESCROW_ADDRESS, EVM_USDC_ADDRESS, EVM_TREASURY_OWNER_1..4 in .env",
    );
  }
}

// Lazily-built clients (per-process singletons). Typed loosely to avoid
// duplicate-type-from-multiple-viem-installs collision.
let _public: ReturnType<typeof createPublicClient> | null = null;
let _wallet: ReturnType<typeof createWalletClient> | null = null;
function publicClient() {
  if (_public) return _public;
  // Loose typing to dodge dup-viem-install type conflicts.
  _public = createPublicClient({ chain: CHAIN, transport: http() } as never);
  return _public;
}
function walletClient() {
  if (_wallet) return _wallet;
  assertConfigured();
  const account = privateKeyToAccount(RESOLVER_PRIVATE_KEY as Hex);
  _wallet = createWalletClient({ account, chain: CHAIN, transport: http() } as never);
  return _wallet;
}

export const resolverAddress: Address | null = RESOLVER_PRIVATE_KEY
  ? privateKeyToAccount(RESOLVER_PRIVATE_KEY as Hex).address
  : null;

// ABIs live in ./evm-abi.ts so they can be imported by the
// scripts/check-evm-abi-sync.ts drift check without triggering the
// full bot env validation.
import { ESCROW_ABI, ERC20_BALANCE_ABI } from "./evm-abi.js";

// ----------------------------------------------------------
// Adapter functions (mirror apps/bot/src/solana.ts naming)
// ----------------------------------------------------------

const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

function asHash(termsHash: Uint8Array | number[] | null | undefined): Hex {
  if (!termsHash) return ZERO_HASH;
  const bytes = termsHash instanceof Uint8Array ? termsHash : Uint8Array.from(termsHash);
  if (bytes.length !== 32) {
    throw new Error(`termsHash must be 32 bytes, got ${bytes.length}`);
  }
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

export async function initializeBetOnChain(args: {
  betId: bigint;
  amount: bigint;
  challenger: string;
  accepter: string;
  termsHash?: Uint8Array | number[] | null;
}): Promise<{ sig: string }> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "initializeBet",
    args: [
      args.betId,
      args.amount,
      args.challenger as Address,
      args.accepter as Address,
      asHash(args.termsHash),
    ],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return { sig };
}

export async function resolveOnChain(args: { betId: bigint; winner: string }): Promise<string> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "resolve",
    args: [args.betId, args.winner as Address],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return sig;
}

export async function arbiterResolveOnChain(args: {
  betId: bigint;
  winner: string;
}): Promise<string> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "arbiterResolve",
    args: [args.betId, args.winner as Address],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return sig;
}

export async function drawOnChain(args: { betId: bigint }): Promise<string> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "draw",
    args: [args.betId],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return sig;
}

export async function refundOnChain(args: { betId: bigint }): Promise<string> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "refund",
    args: [args.betId],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return sig;
}

export async function setFeeBpsForSideOnChain(args: {
  betId: bigint;
  side: string;
  newBps: number;
}): Promise<string> {
  assertConfigured();
  const wc = walletClient();
  const sig = await wc.writeContract({
    chain: CHAIN,
    account: wc.account!,
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "setFeeBpsForSide",
    args: [args.betId, args.side as Address, args.newBps],
  });
  await publicClient().waitForTransactionReceipt({ hash: sig });
  return sig;
}

export async function fetchBetOnChain(betId: bigint) {
  if (!isConfigured) return null;
  const result = (await publicClient().readContract({
    address: ESCROW_ADDRESS as Address,
    abi: ESCROW_ABI,
    functionName: "getBet",
    args: [betId],
  })) as {
    amount: bigint;
    challenger: Address;
    accepter: Address;
    challengerDeposited: boolean;
    accepterDeposited: boolean;
    status: number;
    winner: Address;
    termsHash: Hex;
    challengerFeeBps: number;
    accepterFeeBps: number;
  };
  // Status enum: 0=None,1=Pending,2=Funded,3=Resolved,4=Drawn,5=Refunded
  if (result.status === 0) return null; // bet doesn't exist
  return {
    amount: result.amount,
    challenger: result.challenger,
    accepter: result.accepter,
    challengerDeposited: result.challengerDeposited,
    accepterDeposited: result.accepterDeposited,
    status: ["none", "pending", "funded", "resolved", "drawn", "refunded"][result.status],
    winner: result.winner === "0x0000000000000000000000000000000000000000" ? null : result.winner,
    termsHash: result.termsHash,
  };
}

import { baseExplorerTxUrl } from "./explorer.js";

export function explorerTxUrl(sig: string): string {
  return baseExplorerTxUrl(
    CHAIN.id === baseMainnet.id ? "base" : "base-sepolia",
    sig,
  );
}

/** Read the USDC balance of a Base address. Returns null if the EVM adapter
 *  isn't configured (no env vars). */
export async function fetchUsdcBalance(owner: Address): Promise<bigint | null> {
  if (!isConfigured) return null;
  const result = (await publicClient().readContract({
    address: USDC_ADDRESS as Address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  return result;
}

export const treasuryOwners = TREASURY_OWNERS;
export { CHAIN as evmChain };
