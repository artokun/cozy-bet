import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Client } from "discord.js";
import { getDb, bets } from "@cozy-bet/db";
import { BetStatus } from "@cozy-bet/shared";
import { env } from "./env.js";
import { refundBet } from "./flows.js";
import { updateAnnouncement } from "./discord/announce.js";

/**
 * Background watchdog. Runs three independent ticks on the same interval:
 *
 * 1. Pending-refund: bets stuck in `pending` past
 *    WATCHDOG_PENDING_REFUND_MINUTES auto-refund. Off by default (0).
 *
 * 2. 24h-deadline-nudge: for `funded` bets where `now < deadline` and
 *    `deadline - now ∈ [22h, 26h]`, DM both parties once with a reminder.
 *    Idempotent via `nudge_24h_sent_at`. Disabled if WATCHDOG_NUDGE=false.
 *
 * 3. 2h-deadline-nudge: same but for the 1.5h–2.5h window. Idempotent via
 *    `nudge_2h_sent_at`.
 *
 * Saybet's #1 dispute-prevention feature. Mechanically the bot still
 * arbitrates — but nudges keep most users from drifting into the arbiter
 * fee window.
 */
export function startWatchdog(client: Client): NodeJS.Timeout | null {
  const refundMin = env.WATCHDOG_PENDING_REFUND_MINUTES;
  const nudgeEnabled = env.WATCHDOG_NUDGE_ENABLED;
  if (refundMin <= 0 && !nudgeEnabled) {
    console.log("[watchdog] disabled — no enabled features");
    return null;
  }
  const intervalMs = Math.max(30, env.WATCHDOG_INTERVAL_SECONDS) * 1000;
  console.log(
    `[watchdog] enabled — refund=${refundMin > 0 ? `${refundMin}m` : "off"}, nudge=${nudgeEnabled ? "on" : "off"}, interval=${intervalMs / 1000}s`,
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
  };

  return setInterval(tick, intervalMs);
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
      for (const uid of [b.challengerId, b.accepterId]) {
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
  for (const uid of [bet.challengerId, bet.accepterId]) {
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
