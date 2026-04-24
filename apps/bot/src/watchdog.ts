import { and, eq, lt } from "drizzle-orm";
import type { Client } from "discord.js";
import { getDb, bets } from "@cozy-bet/db";
import { BetStatus } from "@cozy-bet/shared";
import { env } from "./env.js";
import { refundBet } from "./flows.js";
import { updateAnnouncement } from "./discord/announce.js";

/** Find bets stuck in `pending` for longer than the configured cutoff and
 *  refund them. Runs on a background interval. */
export function startWatchdog(client: Client): NodeJS.Timeout | null {
  const refundMin = env.WATCHDOG_PENDING_REFUND_MINUTES;
  if (refundMin <= 0) {
    console.log("[watchdog] disabled (WATCHDOG_PENDING_REFUND_MINUTES=0)");
    return null;
  }
  const intervalMs = Math.max(30, env.WATCHDOG_INTERVAL_SECONDS) * 1000;
  console.log(
    `[watchdog] enabled: auto-refund pending bets after ${refundMin} min, checking every ${intervalMs / 1000}s`,
  );

  const tick = async () => {
    try {
      const cutoff = new Date(Date.now() - refundMin * 60 * 1000);
      const d = getDb(env.DATABASE_URL);
      const stale = await d
        .select()
        .from(bets)
        .where(
          and(eq(bets.status, BetStatus.Pending), lt(bets.createdAt, cutoff)),
        );
      for (const b of stale) {
        try {
          console.log(`[watchdog] refunding stale bet ${b.id}`);
          await refundBet(b.id);
          await updateAnnouncement(client, b.id);
          for (const uid of [b.challengerId, b.accepterId]) {
            try {
              const u = await client.users.fetch(uid);
              await u.send(
                `Your bet #${b.id} has been auto-refunded after ${refundMin} min of inactivity.`,
              );
            } catch {}
          }
        } catch (e) {
          console.error(`[watchdog] failed to refund ${b.id}:`, e);
        }
      }
    } catch (e) {
      console.error("[watchdog] tick error:", e);
    }
  };

  return setInterval(tick, intervalMs);
}
