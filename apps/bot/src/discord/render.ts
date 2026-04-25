import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export function formatAmount(atoms: bigint): string {
  return (Number(atoms) / 1e6).toFixed(2);
}

export function renderBetCard(args: {
  betId: bigint;
  challenger: string;
  accepter: string;
  amount: number;
  description: string;
  /** LLM-disambiguated canonical sentence; rendered alongside the verbatim
   *  description if non-null + different. */
  canonical?: string | null;
  status: string;
  shortcode?: string;
  challengerReliability?: string | null;
  accepterReliability?: string | null;
}) {
  const challengerLabel = args.challengerReliability
    ? `${args.challenger}\n${args.challengerReliability}`
    : args.challenger;
  const accepterLabel = args.accepterReliability
    ? `${args.accepter}\n${args.accepterReliability}`
    : args.accepter;
  const description = args.canonical
    ? `> ${args.description}\n\n**Resolves:** ${args.canonical}`
    : args.description;
  const embed = new EmbedBuilder()
    .setTitle(args.shortcode ? `Bet #${args.shortcode}` : `Bet #${args.betId}`)
    .setDescription(description)
    .addFields(
      { name: "Challenger", value: challengerLabel, inline: true },
      { name: "Accepter", value: accepterLabel, inline: true },
      { name: "Stake", value: `${args.amount} mUSDC each`, inline: true },
      { name: "Status", value: args.status, inline: false },
    )
    .setColor(0x5b8cff);

  function proposeRow(betId: bigint) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept:${betId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`decline:${betId}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
    );
  }

  return { embed, proposeRow };
}

export function formatBet(b: {
  id: bigint;
  description: string;
  amount: bigint;
  status: string;
  shortcode?: string;
}): string {
  const idLabel = b.shortcode ?? `#${b.id}`;
  return `• ${idLabel} — ${formatAmount(b.amount)} mUSDC — ${b.description} — _${b.status}_`;
}
