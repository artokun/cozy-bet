/** Thin wrapper around the bot's HTTP sidecar. On the server we use the
 *  internal URL; on the client we only call the public proxy routes. */

const BOT_API_URL = process.env.BOT_API_URL ?? "http://localhost:3001";

export type WalletLinkSession = {
  nonce: string;
  discordId: string;
  discordTag: string | null;
  expiresAt: string;
  used: boolean;
};

export type BetDetail = {
  id: string; // bigint serialized
  status: string;
  amount: string; // bigint serialized
  tokenMint: string;
  description: string;
  challenger: { discordId: string; wallet: string | null };
  accepter: { discordId: string; wallet: string | null };
  betPda: string | null;
  vaultPda: string | null;
  challengerDeposited: boolean;
  accepterDeposited: boolean;
};

export async function fetchSession(nonce: string): Promise<WalletLinkSession> {
  const r = await fetch(`${BOT_API_URL}/api/wallet-link/${nonce}`, {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`session fetch failed: ${r.status}`);
  return r.json();
}

export async function confirmLink(body: {
  nonce: string;
  walletPubkey: string;
  signatureB58: string;
  message: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch(`${BOT_API_URL}/api/wallet-link/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function fetchBet(id: string): Promise<BetDetail> {
  const r = await fetch(`${BOT_API_URL}/api/bet/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`bet fetch failed: ${r.status}`);
  return r.json();
}

export async function notifyFunded(body: {
  betId: string;
  depositor: string;
  signature: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch(`${BOT_API_URL}/api/bet/${body.betId}/funded`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ depositor: body.depositor, signature: body.signature }),
  });
  return r.json();
}
