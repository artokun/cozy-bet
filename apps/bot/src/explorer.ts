/**
 * Pure explorer URL builders. Lives in its own module so tests can import
 * without env validation. The chain.ts wrapper passes env-derived
 * cluster / network values through.
 */
import type { Chain } from "./chain.js";

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";
export type BaseNetwork = "base" | "base-sepolia";

export function solanaExplorerTxUrl(
  cluster: SolanaCluster,
  sig: string,
): string {
  // Solana Explorer omits ?cluster on mainnet-beta but requires it for
  // devnet / testnet. Match the cluster name to keep the audit story
  // consistent across deployments.
  return cluster === "mainnet-beta"
    ? `https://explorer.solana.com/tx/${sig}`
    : `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
}

export function baseExplorerTxUrl(network: BaseNetwork, sig: string): string {
  const base =
    network === "base"
      ? "https://basescan.org"
      : "https://sepolia.basescan.org";
  return `${base}/tx/${sig}`;
}

/** Pure dispatcher — caller provides the cluster/network values. */
export function explorerTxUrlFor(
  chain: Chain,
  cluster: SolanaCluster,
  network: BaseNetwork,
  sig: string,
): string {
  return chain === "solana"
    ? solanaExplorerTxUrl(cluster, sig)
    : baseExplorerTxUrl(network, sig);
}
