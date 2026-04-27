import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Client } from "discord.js";
import { getDb, bets } from "@cozy-bet/db";
import { BetStatus } from "@cozy-bet/shared";
import { adminDiscordIds, env } from "./env.js";
import { refundBet } from "./flows.js";
import { updateAnnouncement } from "./discord/announce.js";
import { formatAmount } from "./discord/render.js";

/**
 * Background watchdog. Runs five independent ticks on the same interval:
 *
 * 1. Pending-refund: bets stuck in `pending` past
 *    WATCHDOG_PENDING_REFUND_MINUTES auto-refund. Off by default (0).
 *
 * 2. Deadline-nudges (24h + 2h): for `funded` bets where deadline is
 *    approaching, DM both parties once. Idempotent via
 *    `nudge_24h_sent_at` / `nudge_2h_sent_at`. Disabled if
 *    WATCHDOG_NUDGE_ENABLED=false.
 *
 * 3. Cancel-expiry: clears /cancel requests that have sat 24h without
 *    Agree/Deny. Always on (we promise users this 24h auto-expire).
 *
 * 4. Arbiter-stale: DMs admins once when /requestarbiter has gone >24h
 *    without an /arbiter-claim. Always on; idempotent via
 *    `arbiter_nudge_sent_at`.
 *
 * 5. Stale-lock: clears "PENDING:*" sentinels in resolution_tx_sig /
 *    init_tx_sig / share_url that are >5min old. Catches the case
 *    where the bot crashed mid-chain-call and the catch path that
 *    would have released the lock never ran. Without this, a bet
 *    stays in lock-held state forever and the user can't retry.
 *
 * Saybet's #1 dispute-prevention feature. Mechanically the bot still
 * arbitrates — but nudges keep most users from drifting into the arbiter
 * fee window.
 */
export function startWatchdog(client: Client): NodeJS.Timeout {
  const refundMin = env.WATCHDOG_PENDING_REFUND_MINUTES;
  const nudgeEnabled = env.WATCHDOG_NUDGE_ENABLED;
  // Cancel-expiry is always on — there's no env switch to disable it,
  // because we promise users a 24h auto-expire on /cancel requests.
  const intervalMs = Math.max(30, env.WATCHDOG_INTERVAL_SECONDS) * 1000;
  console.log(
    `[watchdog] enabled — refund=${refundMin > 0 ? `${refundMin}m` : "off"}, nudge=${nudgeEnabled ? "on" : "off"}, cancel-expiry=on, interval=${intervalMs / 1000}s`,
  );

  const tick = async () => {
    try {
      if (refundMin > 0) await tickPendingRefund(client, refundMin);
    } catch (e) {
      console.error("[watchdog] pending-refund tick error:", e);
    }
    try {
      if (nudgeEnabled) await tickDeadlineNudges(client);
    } catch (e) {
      console.error("[watchdog] nudge tick error:", e);
    }
    try {
      await tickCancelExpiry(client);
    } catch (e) {
      console.error("[watchdog] cancel-expiry tick error:", e);
    }
    try {
      await tickArbiterStale(client);
    } catch (e) {
      console.error("[watchdog] arbiter-stale tick error:", e);
    }
    try {
      await tickStaleLocks();
    } catch (e) {
      console.error("[watchdog] stale-lock tick error:", e);
    }
  };

  return setInterval(tick, intervalMs);
}

/**
 * Auto-expire mutual-cancel requests after 24h with no Agree/Deny. Clears
 * cancel_requested_at + cancel_requested_by; the bet stays active.
 */
async function tickCancelExpiry(client: Client) {
  const d = getDb(env.DATABASE_URL);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stale = await d
    .select()
    .from(bets)
    .where(
      and(
        // Use SQL: not null + < cutoff
        // drizzle: cancelRequestedAt IS NOT NULL AND cancelRequestedAt < cutoff
        sql`${bets.cancelRequestedAt} IS NOT NULL`,
        lt(bets.cancelRequestedAt, cutoff),
      ),
    );
  for (const b of stale) {
    try {
      await d
        .update(bets)
        .set({ cancelRequestedAt: null, cancelRequestedBy: null })
        .where(eq(bets.id, b.id));
      console.log(`[watchdog] expired cancel request on bet ${b.shortcode}`);
      // DM the requester so they know it timed out.
      if (b.cancelRequestedBy) {
        try {
          const u = await client.users.fetch(b.cancelRequestedBy);
          await u.send(
            `Your cancel request on bet \`${b.shortcode}\` expired (24h with no response). Bet stays active. Try /cancel again or /resolve when the time comes.`,
          );
        } catch {}
      }
    } catch (e) {
      console.error(`[watchdog] failed to expire cancel for ${b.id}:`, e);
    }
  }
}

async function tickPendingRefund(client: Client, refundMin: number) {
  const cutoff = new Date(Date.now() - refundMin * 60 * 1000);
  const d = getDb(env.DATABASE_URL);
  const stale = await d
    .select()
    .from(bets)
    .where(and(eq(bets.status, BetStatus.Pending), lt(bets.createdAt, cutoff)));
  for (const b of stale) {
    try {
      console.log(`[watchdog] refunding stale bet ${b.shortcode} (id ${b.id})`);
      await refundBet(b.id);
      await updateAnnouncement(client, b.id);
      const recipients = b.accepterId
        ? [b.challengerId, b.accepterId]
        : [b.challengerId];
      for (const uid of recipients) {
        try {
          const u = await client.users.fetch(uid);
          await u.send(
            `Your bet \`${b.shortcode}\` was auto-refunded after ${refundMin} min of inactivity.`,
          );
        } catch {}
      }
    } catch (e) {
      console.error(`[watchdog] failed to refund ${b.id}:`, e);
    }
  }
}

async function tickDeadlineNudges(client: Client) {
  const d = getDb(env.DATABASE_URL);
  const now = new Date();

  // 24h nudge: deadline > 2h away (so we don't double-send with the 2h
  // nudge in the same tick) AND <= 24h away AND not yet sent. Catches up
  // missed ticks down to 2h before deadline; below that, the 2h copy fires
  // instead.
  const lower24 = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const upper24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const due24 = await d
    .select()
    .from(bets)
    .where(
      and(
        eq(bets.status, BetStatus.Funded),
        isNull(bets.nudge24hSentAt),
        gt(bets.deadline, lower24),
        lt(bets.deadline, upper24),
      ),
    );
  for (const b of due24) {
    await sendNudge(client, b, "24h");
    await d
      .update(bets)
      .set({ nudge24hSentAt: now })
      .where(eq(bets.id, b.id));
  }

  // 2h nudge: deadline still in the future AND <= 2h away AND not yet sent.
  const upper2 = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const due2 = await d
    .select()
    .from(bets)
    .where(
      and(
        eq(bets.status, BetStatus.Funded),
        isNull(bets.nudge2hSentAt),
        gt(bets.deadline, now),
        lt(bets.deadline, upper2),
      ),
    );
  for (const b of due2) {
    await sendNudge(client, b, "2h");
    await d
      .update(bets)
      .set({ nudge2hSentAt: now })
      .where(eq(bets.id, b.id));
  }
}

/**
 * Stale-arbiter nudge. /requestarbiter sets arbiter_requested_at but no admin
 * has run /arbiter-claim within 24h → DM every admin once and mark
 * arbiter_nudge_sent_at so we don't re-spam them. Fires regardless of the
 * WATCHDOG_NUDGE_ENABLED switch — arbiter requests are load-bearing for
 * dispute resolution and can't be silenced.
 */
async function tickArbiterStale(client: Client) {
  const d = getDb(env.DATABASE_URL);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stale = await d
    .select()
    .from(bets)
    .where(
      and(
        sql`${bets.arbiterRequestedAt} IS NOT NULL`,
        sql`${bets.arbiterDiscordId} IS NULL`,
        sql`${bets.arbiterNudgeSentAt} IS NULL`,
        lt(bets.arbiterRequestedAt, cutoff),
      ),
    );
  if (stale.length === 0) return;
  const admins = adminDiscordIds();
  if (admins.length === 0) {
    // No admins configured — log loudly so the operator notices.
    console.warn(
      `[watchdog] ${stale.length} arbiter request(s) >24h old but ADMIN_DISCORD_IDS is empty`,
    );
    return;
  }
  for (const b of stale) {
    const requestedAgo = Math.round(
      (Date.now() - new Date(b.arbiterRequestedAt!).getTime()) / 3_600_000,
    );
    const body = [
      `🛎️ **Stale arbiter request** — bet \`${b.shortcode}\` has been waiting **${requestedAgo}h** with no admin claim.`,
      `Chain: ${b.chain === "solana" ? "Solana" : "Base"} · Stake: ${formatAmount(BigInt(b.amount))} USDC each`,
      `Challenger: <@${b.challengerId}> · Accepter: <@${b.accepterId ?? "?"}>`,
      `Requested by: <@${b.arbiterRequestedBy ?? "?"}>`,
      ``,
      `Run \`/arbiter-claim bet_id:${b.shortcode}\` to take the case.`,
    ].join("\n");
    let delivered = 0;
    for (const adminId of admins) {
      try {
        const u = await client.users.fetch(adminId);
        await u.send(body);
        delivered++;
      } catch (e) {
        console.warn(
          `[watchdog] stale-arbiter DM to admin ${adminId} for ${b.shortcode} failed:`,
          String(e),
        );
      }
    }
    // Mark sent so we don't re-DM, even if we couldn't reach every admin —
    // re-running every interval would spam those that we DID reach.
    await d
      .update(bets)
      .set({ arbiterNudgeSentAt: new Date() })
      .where(eq(bets.id, b.id));
    console.log(
      `[watchdog] arbiter-stale nudge sent for ${b.shortcode} (${delivered}/${admins.length} admins reached)`,
    );
  }
}

/**
 * Clear stale "PENDING:*" lock sentinels in resolution_tx_sig /
 * init_tx_sig / share_url columns.
 *
 * The locks (claimResolutionLock, initializeOnChain's slot claim,
 * applyShareDiscount's per-side slot) are normally released either by
 * being overwritten with a real tx hash on success, or cleared back to
 * NULL by the catch path on chain-call failure. But if the bot crashes
 * mid-call, the catch path never runs — the sentinel sticks forever
 * and the user can never retry.
 *
 * This tick clears any sentinel older than the lock-stale window (5
 * minutes). 5min is well above the slowest realistic chain* call
 * (Solana <3s typical, Base <30s typical) so we won't trample a
 * slow-but-still-running call.
 */
const LOCK_STALE_MS = 5 * 60 * 1000;

/** Sentinel format is `PENDING:<reason>:<unix-ms>`. Returns the embedded
 *  ms timestamp, or null if the value isn't a sentinel or the timestamp
 *  is unparseable. */
function lockAcquiredAt(sentinel: string | null): number | null {
  if (!sentinel || !sentinel.startsWith("PENDING:")) return null;
  // Last `:`-separated segment should be the unix-ms.
  const lastColon = sentinel.lastIndexOf(":");
  if (lastColon === "PENDING:".length - 1) return null;
  const raw = sentinel.slice(lastColon + 1);
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

async function tickStaleLocks() {
  const d = getDb(env.DATABASE_URL);
  const now = Date.now();
  // Pull every bet with any PENDING lock currently held. Per-row check
  // gates on the embedded timestamp so we don't trample a just-acquired
  // lock — bet.createdAt is the wrong column (bet may be weeks old, lock
  // just acquired) so we can't use it.
  const candidates = await d
    .select()
    .from(bets)
    .where(
      sql`(${bets.resolutionTxSig} LIKE 'PENDING:%' OR ${bets.initTxSig} LIKE 'PENDING:%' OR ${bets.challengerShareUrl} LIKE 'PENDING:%' OR ${bets.accepterShareUrl} LIKE 'PENDING:%')`,
    );
  for (const b of candidates) {
    const patch: Partial<typeof bets.$inferInsert> = {};
    const tryClear = (
      column: keyof typeof bets.$inferInsert,
      value: string | null,
    ) => {
      if (!value?.startsWith("PENDING:")) return;
      const acquired = lockAcquiredAt(value);
      // Missing timestamp = legacy sentinel from before the format
      // change; treat as stale (worst case: clears a just-acquired lock
      // mid-deploy, user retries — same UX as a chain RPC timeout).
      if (acquired === null || now - acquired > LOCK_STALE_MS) {
        // @ts-expect-error — typed map to a nullable string column
        patch[column] = null;
      }
    };
    tryClear("resolutionTxSig", b.resolutionTxSig);
    tryClear("initTxSig", b.initTxSig);
    tryClear("challengerShareUrl", b.challengerShareUrl);
    tryClear("accepterShareUrl", b.accepterShareUrl);
    if (Object.keys(patch).length === 0) continue;
    await d.update(bets).set(patch).where(eq(bets.id, b.id));
    console.warn(
      `[watchdog] cleared stale lock(s) on bet ${b.shortcode}: ${Object.keys(patch).join(", ")}`,
    );
  }
}

async function sendNudge(
  client: Client,
  bet: typeof bets.$inferSelect,
  window: "24h" | "2h",
) {
  const label = window === "24h" ? "24h" : "2h";
  const verbatim = `> ${bet.description}`;
  const body =
    window === "24h"
      ? `⏰ **${label} to go** on your bet \`${bet.shortcode}\`:\n${verbatim}\n\nMake sure you'll be around to /resolve when the time comes. If you and your counterparty disagree on the outcome, either side can request an arbiter (admin) — that costs max(\$100, 1% of pot) from the pot.`
      : `⏰ **${label} to go** on your bet \`${bet.shortcode}\`:\n${verbatim}\n\nBe ready to /resolve. Both sides need to confirm the same winner — or run /draw if you both agree it's a tie.`;
  const recipients = bet.accepterId
    ? [bet.challengerId, bet.accepterId]
    : [bet.challengerId];
  for (const uid of recipients) {
    try {
      const u = await client.users.fetch(uid);
      await u.send(body);
    } catch (e) {
      console.warn(
        `[watchdog] nudge DM to ${uid} (bet ${bet.shortcode}, ${window}) failed:`,
        String(e),
      );
    }
  }
}
