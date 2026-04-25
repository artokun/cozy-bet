import express from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { getDb, walletLinkSessions, bets, users } from "@cozy-bet/db";
import { env, allowedGuilds } from "./env.js";
import { recordDeposit, setUserWallet } from "./flows.js";
import { updateAnnouncement } from "./discord/announce.js";
import type { Client } from "discord.js";

export function startApi(client: Client) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/wallet-link/:nonce", async (req, res) => {
    const d = getDb(env.DATABASE_URL);
    const rows = await d
      .select()
      .from(walletLinkSessions)
      .where(eq(walletLinkSessions.nonce, req.params.nonce));
    const session = rows[0];
    if (!session) return res.status(404).json({ error: "not found" });
    if (session.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: "expired" });
    }
    let discordTag: string | null = null;
    try {
      const u = await client.users.fetch(session.discordId);
      discordTag = u.username;
    } catch {}
    res.json({
      nonce: session.nonce,
      discordId: session.discordId,
      discordTag,
      expiresAt: session.expiresAt.toISOString(),
      used: Boolean(session.usedAt),
    });
  });

  app.post("/api/wallet-link/confirm", async (req, res) => {
    const { nonce, walletPubkey, signatureB58, message } = req.body ?? {};
    if (!nonce || !walletPubkey || !signatureB58 || !message) {
      return res.json({ ok: false, error: "missing fields" });
    }
    const d = getDb(env.DATABASE_URL);
    const rows = await d
      .select()
      .from(walletLinkSessions)
      .where(eq(walletLinkSessions.nonce, nonce));
    const session = rows[0];
    if (!session) return res.json({ ok: false, error: "session not found" });
    if (session.expiresAt.getTime() < Date.now()) {
      return res.json({ ok: false, error: "session expired" });
    }
    if (session.usedAt) return res.json({ ok: false, error: "session used" });

    const expected = `cozy-bet link: ${session.nonce} for discord:${session.discordId}`;
    if (message !== expected) return res.json({ ok: false, error: "message mismatch" });

    const pk = new PublicKey(walletPubkey);
    const sig = bs58.decode(signatureB58);
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      sig,
      pk.toBytes(),
    );
    if (!ok) return res.json({ ok: false, error: "bad signature" });

    await setUserWallet(session.discordId, walletPubkey);
    await d
      .update(walletLinkSessions)
      .set({ usedAt: new Date() })
      .where(eq(walletLinkSessions.nonce, nonce));

    try {
      const u = await client.users.fetch(session.discordId);
      await u.send(`✅ Wallet linked: \`${walletPubkey}\``);
    } catch {}
    res.json({ ok: true });
  });

  app.get("/api/bet/:id", async (req, res) => {
    let id: bigint;
    try {
      id = BigInt(req.params.id);
    } catch {
      return res.status(400).json({ error: "bad id" });
    }
    const d = getDb(env.DATABASE_URL);
    const rows = await d.select().from(bets).where(eq(bets.id, id));
    const bet = rows[0];
    if (!bet) return res.status(404).json({ error: "not found" });
    const challenger = (
      await d.select().from(users).where(eq(users.discordId, bet.challengerId))
    )[0];
    const accepter = bet.accepterId
      ? (await d.select().from(users).where(eq(users.discordId, bet.accepterId)))[0]
      : null;
    res.json({
      id: bet.id.toString(),
      status: bet.status,
      amount: bet.amount.toString(),
      tokenMint: bet.tokenMint,
      description: bet.description,
      challenger: {
        discordId: bet.challengerId,
        wallet: challenger?.walletPubkey ?? null,
      },
      accepter: bet.accepterId
        ? {
            discordId: bet.accepterId,
            wallet: accepter?.walletPubkey ?? null,
          }
        : null,
      isOpen: bet.isOpen,
      betPda: bet.betPda,
      vaultPda: bet.vaultPda,
      challengerDeposited: bet.challengerDeposited,
      accepterDeposited: bet.accepterDeposited,
    });
  });

  app.post("/api/bet/:id/funded", async (req, res) => {
    let id: bigint;
    try {
      id = BigInt(req.params.id);
    } catch {
      return res.json({ ok: false, error: "bad id" });
    }
    const { depositor, signature } = req.body ?? {};
    if (!depositor || !signature) {
      return res.json({ ok: false, error: "missing fields" });
    }
    try {
      const result = await recordDeposit(id, depositor, signature);
      await updateAnnouncement(client, id);
      res.json({ ok: true, fullyFunded: result.fullyFunded });
    } catch (e: any) {
      res.json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  return app.listen(env.BOT_API_PORT, () => {
    console.log(`[api] listening on :${env.BOT_API_PORT}`);
  });
}
