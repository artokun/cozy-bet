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
  /** Settlement chain ("solana" | "base"). Shown as the stake suffix. */
  settlementChain?: "solana" | "base" | null;
  challengerReliability?: string | null;
  accepterReliability?: string | null;
  /** Double-or-Nothing chain. >0 means this is a rematch. */
  chainDepth?: number | null;
  parentShortcode?: string | null;
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
  const titleSuffix =
    args.chainDepth && args.chainDepth > 0
      ? args.parentShortcode
        ? ` · 🎲 Rematch #${args.chainDepth} (parent: #${args.parentShortcode})`
        : ` · 🎲 Rematch #${args.chainDepth}`
      : "";
  const embed = new EmbedBuilder()
    .setTitle(
      (args.shortcode ? `Bet #${args.shortcode}` : `Bet #${args.betId}`) + titleSuffix,
    )
    .setDescription(description)
    .addFields(
      { name: "Challenger", value: challengerLabel, inline: true },
      { name: "Accepter", value: accepterLabel, inline: true },
      {
        name: "Stake",
        value:
          `${args.amount} USDC each` +
          (args.settlementChain
            ? ` · ${args.settlementChain === "solana" ? "Solana" : "Base"}`
            : ""),
        inline: true,
      },
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
  /** Pending state badges: surface mid-flight workflows so a user reading
   *  /mybets sees "your cancel request awaits agreement" without needing
   *  to /status every bet. All optional — narrow callers (formatBet
   *  outside of mybets) can pass plain shape. */
  counterAt?: Date | null;
  cancelRequestedAt?: Date | null;
  arbiterRequestedAt?: Date | null;
}): string {
  const idLabel = b.shortcode ?? `#${b.id}`;
  const badges: string[] = [];
  if (b.counterAt) badges.push("📝 counter-proposed");
  if (b.cancelRequestedAt) badges.push("🚫 cancel requested");
  if (b.arbiterRequestedAt) badges.push("🛎️ arbiter requested");
  const badgeStr = badges.length > 0 ? ` · ${badges.join(" · ")}` : "";
  return `• ${idLabel} — ${formatAmount(b.amount)} USDC — ${b.description} — _${b.status}_${badgeStr}`;
}
