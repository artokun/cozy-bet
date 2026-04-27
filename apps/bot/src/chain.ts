/**
 * Chain dispatcher. flows.ts calls into this for any on-chain operation;
 * we route to the Solana or EVM (Base) adapter based on the bet's `chain`
 * column.
 *
 * Both adapters expose roughly the same surface (initializeBet / resolve /
 * arbiterResolve / draw / refund / setFeeBpsForSide / fetchBet). This file
 * normalizes their input/output shapes and converts wallet addresses where
 * needed (Solana's helpers want PublicKey, EVM's want hex strings).
 */
import { PublicKey } from "@solana/web3.js";
import * as sol from "./solana.js";
import * as evm from "./evm.js";
import { env } from "./env.js";
import {
  explorerTxUrlFor,
  type BaseNetwork,
  type SolanaCluster,
} from "./explorer.js";

export type Chain = "solana" | "base";

export type BetChainState = {
  amount: bigint;
  challenger: string;
  accepter: string;
  challengerDeposited: boolean;
  accepterDeposited: boolean;
  status: "pending" | "funded" | "resolved" | "drawn" | "refunded" | "none";
  winner: string | null;
};

function isSolana(chain: Chain): chain is "solana" {
  return chain === "solana";
}

export async function chainInitializeBet(
  chain: Chain,
  args: {
    betId: bigint;
    amount: bigint;
    challenger: string;
    accepter: string;
    termsHash?: Uint8Array | number[] | null;
  },
): Promise<{ sig: string; betPda?: string; vaultPda?: string }> {
  if (isSolana(chain)) {
    const { sig, betPda, vaultPda } = await sol.initializeBetOnChain({
      betId: args.betId,
      amount: args.amount,
      challenger: new PublicKey(args.challenger),
      accepter: new PublicKey(args.accepter),
      termsHash: args.termsHash ?? null,
    });
    return { sig, betPda: betPda.toBase58(), vaultPda: vaultPda.toBase58() };
  }
  return evm.initializeBetOnChain(args);
}

export async function chainResolve(
  chain: Chain,
  args: { betId: bigint; winner: string },
): Promise<string> {
  if (isSolana(chain)) {
    return sol.resolveOnChain({
      betId: args.betId,
      winner: new PublicKey(args.winner),
    });
  }
  return evm.resolveOnChain(args);
}

export async function chainArbiterResolve(
  chain: Chain,
  args: { betId: bigint; winner: string },
): Promise<string> {
  if (isSolana(chain)) {
    return sol.arbiterResolveOnChain({
      betId: args.betId,
      winner: new PublicKey(args.winner),
    });
  }
  return evm.arbiterResolveOnChain(args);
}

export async function chainDraw(
  chain: Chain,
  args: { betId: bigint; challenger: string; accepter: string },
): Promise<string> {
  if (isSolana(chain)) {
    return sol.drawOnChain({
      betId: args.betId,
      challenger: new PublicKey(args.challenger),
      accepter: new PublicKey(args.accepter),
    });
  }
  // EVM draw doesn't need challenger/accepter args (contract reads from storage)
  return evm.drawOnChain({ betId: args.betId });
}

export async function chainRefund(
  chain: Chain,
  args: { betId: bigint; challenger: string; accepter: string },
): Promise<string> {
  if (isSolana(chain)) {
    return sol.refundOnChain({
      betId: args.betId,
      challenger: new PublicKey(args.challenger),
      accepter: new PublicKey(args.accepter),
    });
  }
  return evm.refundOnChain({ betId: args.betId });
}

export async function chainSetFeeBpsForSide(
  chain: Chain,
  args: { betId: bigint; side: string; newBps: number },
): Promise<string> {
  if (isSolana(chain)) {
    return sol.setFeeBpsForSideOnChain({
      betId: args.betId,
      side: new PublicKey(args.side),
      newBps: args.newBps,
    });
  }
  return evm.setFeeBpsForSideOnChain(args);
}

export async function chainFetchBet(
  chain: Chain,
  betId: bigint,
): Promise<BetChainState | null> {
  if (isSolana(chain)) {
    const b = await sol.fetchBetOnChain(betId);
    if (!b) return null;
    return {
      amount: BigInt(b.amount.toString()),
      challenger: b.challenger.toBase58(),
      accepter: b.accepter.toBase58(),
      challengerDeposited: b.challengerDeposited,
      accepterDeposited: b.accepterDeposited,
      status:
        "pending" in b.status
          ? "pending"
          : "funded" in b.status
            ? "funded"
            : "resolved" in b.status
              ? "resolved"
              : "drawn" in b.status
                ? "drawn"
                : "refunded" in b.status
                  ? "refunded"
                  : "none",
      winner: b.winner.toBase58() === "11111111111111111111111111111111" ? null : b.winner.toBase58(),
    };
  }
  const b = await evm.fetchBetOnChain(betId);
  if (!b) return null;
  return {
    amount: b.amount,
    challenger: b.challenger,
    accepter: b.accepter,
    challengerDeposited: b.challengerDeposited,
    accepterDeposited: b.accepterDeposited,
    status: b.status as BetChainState["status"],
    winner: b.winner,
  };
}

export function chainExplorerTxUrl(chain: Chain, sig: string): string {
  return explorerTxUrlFor(
    chain,
    env.SOLANA_CLUSTER as SolanaCluster,
    env.EVM_NETWORK as BaseNetwork,
    sig,
  );
}
