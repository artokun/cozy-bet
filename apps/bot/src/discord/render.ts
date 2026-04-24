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
  status: string;
}) {
  const embed = new EmbedBuilder()
    .setTitle(`Bet #${args.betId}`)
    .setDescription(args.description)
    .addFields(
      { name: "Challenger", value: args.challenger, inline: true },
      { name: "Accepter", value: args.accepter, inline: true },
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
}): string {
  return `• #${b.id} — ${formatAmount(b.amount)} mUSDC — ${b.description} — _${b.status}_`;
}
