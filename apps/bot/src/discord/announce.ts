import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type MessageEditOptions,
} from "discord.js";
import { getBet } from "../flows.js";
import { getDb, users } from "@cozy-bet/db";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { formatAmount } from "./render.js";

const STATUS_COLORS: Record<string, number> = {
  proposed: 0x5b8cff,
  accepted: 0xf6c744,
  pending: 0xf6c744,
  funded: 0x5b8cff,
  resolved: 0x2ebe6f,
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
  const accepterRow = (
    await d.select().from(users).where(eq(users.discordId, bet.accepterId))
  )[0];

  const embed = new EmbedBuilder()
    .setTitle(`Bet #${bet.id}`)
    .setDescription(bet.description)
    .setColor(STATUS_COLORS[bet.status] ?? 0x5b8cff)
    .addFields(
      { name: "Challenger", value: `<@${bet.challengerId}>`, inline: true },
      { name: "Accepter", value: `<@${bet.accepterId}>`, inline: true },
      { name: "Stake", value: `${formatAmount(BigInt(bet.amount))} mUSDC each`, inline: true },
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
  if (bet.resolutionTxSig) {
    embed.addFields({
      name: "Tx",
      value: `[explorer](https://explorer.solana.com/tx/${bet.resolutionTxSig}?cluster=devnet)`,
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
