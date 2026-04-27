import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { getBet } from "../flows.js";
import { getDb, users, betEvents } from "@cozy-bet/db";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { formatAmount } from "./render.js";
import { chainExplorerTxUrl, type Chain } from "../chain.js";
import { isRealTxSig } from "../explorer.js";

const STATUS_COLORS: Record<string, number> = {
  proposed: 0x5b8cff,
  accepted: 0xf6c744,
  pending: 0xf6c744,
  funded: 0x5b8cff,
  resolved: 0x2ebe6f,
  drawn: 0x6f7ce0,
  refunded: 0x888897,
  canceled: 0x888897,
  disputed: 0xe0533b,
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "🎲 Proposed — awaiting accepter",
  accepted: "🤝 Accepted — linking + funding",
  pending: "💸 Funding in progress",
  funded: "🔒 Locked — awaiting resolution",
  resolved: "🏆 Resolved",
  drawn: "🤝 Drawn — both stakes refunded",
  refunded: "↩️ Refunded",
  canceled: "🚫 Canceled",
  disputed: "⚠️ Disputed — admin review needed",
};

/** Rebuild the announcement message for a bet based on its current DB state.
 *  Called after every state-changing action so the in-channel card is live. */
export async function updateAnnouncement(client: Client, betId: bigint) {
  const bet = await getBet(betId);
  if (!bet || !bet.announceMessageId) return;

  const d = getDb(env.DATABASE_URL);
  const challengerRow = (
    await d.select().from(users).where(eq(users.discordId, bet.challengerId))
  )[0];
  const accepterRow = bet.accepterId
    ? (await d.select().from(users).where(eq(users.discordId, bet.accepterId)))[0]
    : null;

  const accepterLabel = bet.accepterId
    ? `<@${bet.accepterId}>`
    : "_(open — first to claim)_";

  const chain = bet.chain as Chain;
  const chainSuffix = chain === "solana" ? "Solana" : "Base";
  const embed = new EmbedBuilder()
    .setTitle(`Bet #${bet.shortcode ?? bet.id}`)
    .setDescription(bet.description)
    .setColor(STATUS_COLORS[bet.status] ?? 0x5b8cff)
    .addFields(
      { name: "Challenger", value: `<@${bet.challengerId}>`, inline: true },
      { name: "Accepter", value: accepterLabel, inline: true },
      {
        name: "Stake",
        value: `${formatAmount(BigInt(bet.amount))} USDC each · ${chainSuffix}`,
        inline: true,
      },
      { name: "Status", value: STATUS_LABELS[bet.status] ?? bet.status, inline: false },
    );

  const fundingLine: string[] = [];
  if (bet.status === "pending" || bet.status === "accepted") {
    fundingLine.push(
      `Challenger: ${bet.challengerDeposited ? "✅ deposited" : "⏳"}`,
    );
    fundingLine.push(
      `Accepter: ${bet.accepterDeposited ? "✅ deposited" : "⏳"}`,
    );
  }
  if (bet.winnerId) {
    embed.addFields({
      name: "Winner",
      value: `<@${bet.winnerId}>`,
      inline: true,
    });
  }
  if (isRealTxSig(bet.resolutionTxSig)) {
    embed.addFields({
      name: "Tx",
      value: `[explorer](${chainExplorerTxUrl(chain, bet.resolutionTxSig)})`,
      inline: true,
    });
  }
  if (fundingLine.length) {
    embed.addFields({ name: "Deposits", value: fundingLine.join(" · ") });
  }

  // Only propose Accept/Decline buttons while Proposed.
  const components =
    bet.status === "proposed"
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`accept:${bet.id}`)
              .setLabel("Accept")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`decline:${bet.id}`)
              .setLabel("Decline")
              .setStyle(ButtonStyle.Danger),
          ),
        ]
      : [];

  try {
    const channel = await client.channels.fetch(bet.channelId);
    if (!channel?.isTextBased()) return;
    const msg = await channel.messages.fetch(bet.announceMessageId);
    const edit: MessageEditOptions = { embeds: [embed], components };
    // Clear the original "you've been challenged" content once proposed phase ends
    if (bet.status !== "proposed") edit.content = "";
    await msg.edit(edit);
  } catch (e) {
    console.warn("[announce] failed to update message", String(e));
  }

  // Tag both participants in-channel on terminal transitions for visibility
  if (bet.status === "funded" || bet.status === "resolved" || bet.status === "refunded") {
    // Only tag once per transition — detect via the bet_events audit log
    // (simpler: do nothing here and let the caller optionally ping)
  }
  void challengerRow;
  void accepterRow;
}

/**
 * Try to send a message in a channel. If the bot can't reach it (perms, rate
 * limit, channel deleted, etc.), DM each participant the same content as a
 * fallback. Logs a 'channel_fallback' event to the bet's audit log on
 * fallback so we can detect chronic problems later.
 *
 * Returns true if the channel send succeeded; false if it fell back to DMs;
 * throws only if BOTH paths fail (extremely rare).
 */
export async function safeChannelSend(
  client: Client,
  args: {
    channelId: string;
    payload: MessageCreateOptions;
    /** Discord user ids to DM if the channel send fails. */
    fallbackRecipients: string[];
    /** Optional bet id — if provided, channel-fallback events are logged. */
    betId?: bigint;
  },
): Promise<boolean> {
  try {
    const ch = await client.channels.fetch(args.channelId);
    if (ch && ch.isTextBased() && "send" in ch) {
      await ch.send(args.payload);
      return true;
    }
  } catch (e) {
    console.warn(
      `[safeChannelSend] channel ${args.channelId} send failed:`,
      String(e),
    );
  }
  // Fallback: DM each recipient
  let anyDmSucceeded = false;
  for (const uid of args.fallbackRecipients) {
    try {
      const u = await client.users.fetch(uid);
      await u.send(args.payload);
      anyDmSucceeded = true;
    } catch (e) {
      console.warn(`[safeChannelSend] DM to ${uid} failed:`, String(e));
    }
  }
  if (args.betId !== undefined) {
    try {
      const d = getDb(env.DATABASE_URL);
      await d.insert(betEvents).values({
        betId: args.betId,
        eventType: "channel_fallback",
        payload: {
          channelId: args.channelId,
          fallbackRecipients: args.fallbackRecipients,
          dmSucceeded: anyDmSucceeded,
        },
      });
    } catch {
      // best-effort logging
    }
  }
  if (!anyDmSucceeded) {
    throw new Error(
      `safeChannelSend failed: channel + all DM fallbacks rejected`,
    );
  }
  return false;
}
