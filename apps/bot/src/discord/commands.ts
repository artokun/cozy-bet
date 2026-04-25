import {
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { formatAmount, formatBet, renderBetCard } from "./render.js";
import {
  acceptBet,
  adminResolve,
  claimWinner,
  createWalletLinkSession,
  declineBet,
  findBetByIdOrShortcode,
  getBet,
  getUser,
  initializeOnChain,
  isAllowed,
  leaderboardData,
  listActiveBetsFor,
  proposeBet,
  reconcileBet,
  refundBet,
  reliabilityLabel,
  setAnnounceMessageId,
} from "../flows.js";
import { isAdmin } from "../env.js";
import { connection, mockUsdcMint } from "../solana.js";
import { updateAnnouncement } from "./announce.js";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

/** The mockUSDC mint has 6 decimals in our setup. */
const MINT_DECIMALS = 6;

function dollarsToAtoms(dollars: number): bigint {
  return BigInt(Math.round(dollars * 10 ** MINT_DECIMALS));
}

export const saybet = new SlashCommandBuilder()
  .setName("saybet")
  .setDescription("Challenge another user to a bet")
  .addUserOption((o) =>
    o.setName("user").setDescription("who you want to bet").setRequired(true),
  )
  .addNumberOption((o) =>
    o
      .setName("amount")
      .setDescription("amount in mockUSDC (min 1)")
      .setMinValue(1)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("description")
      .setDescription("what is the bet?")
      .setMaxLength(200)
      .setRequired(true),
  );

export const mybets = new SlashCommandBuilder()
  .setName("mybets")
  .setDescription("List your active bets");

export const resolveCmd = new SlashCommandBuilder()
  .setName("resolve")
  .setDescription("Claim the winner of a funded bet")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  )
  .addUserOption((o) =>
    o.setName("winner").setDescription("winning user").setRequired(true),
  );

export const cancelCmd = new SlashCommandBuilder()
  .setName("cancel")
  .setDescription("Refund a pending/funded/disputed bet (both sides agreed)")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  );

export const linkwallet = new SlashCommandBuilder()
  .setName("linkwallet")
  .setDescription("Link your Solana wallet to your Discord account");

export const adminresolve = new SlashCommandBuilder()
  .setName("adminresolve")
  .setDescription("(admin) Force-resolve a disputed or stuck bet")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  )
  .addUserOption((o) =>
    o.setName("winner").setDescription("winning user").setRequired(true),
  );

export const reconcile = new SlashCommandBuilder()
  .setName("reconcile")
  .setDescription("(admin) Re-sync a bet's DB state from on-chain truth")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  );

export const helpCmd = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use cozy-bet");

export const balanceCmd = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Show your mUSDC balance");

export const statusCmd = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show full detail on a bet")
  .addStringOption((o) =>
    o
      .setName("bet_id")
      .setDescription("bet id or shortcode")
      .setRequired(true),
  );

export const leaderboardCmd = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Top wagerers in this server")
  .addStringOption((o) =>
    o
      .setName("by")
      .setDescription("ranking criterion")
      .addChoices(
        { name: "won (USDC)", value: "won" },
        { name: "wagered (USDC)", value: "wagered" },
        { name: "win rate (min 5 bets)", value: "winrate" },
      ),
  );

export const commandDefinitions: RESTPostAPIApplicationCommandsJSONBody[] = [
  saybet.toJSON(),
  mybets.toJSON(),
  resolveCmd.toJSON(),
  cancelCmd.toJSON(),
  linkwallet.toJSON(),
  balanceCmd.toJSON(),
  helpCmd.toJSON(),
  statusCmd.toJSON(),
  leaderboardCmd.toJSON(),
  adminresolve.toJSON(),
  reconcile.toJSON(),
];

export async function handleSaybet(i: ChatInputCommandInteraction) {
  if (!i.guildId) {
    await i.reply({ content: "Use this in a server, not DMs.", ephemeral: true });
    return;
  }
  const target = i.options.getUser("user", true);
  const amount = i.options.getNumber("amount", true);
  const description = i.options.getString("description", true);
  if (target.id === i.user.id) {
    await i.reply({ content: "You can't bet yourself.", ephemeral: true });
    return;
  }
  if (target.bot) {
    await i.reply({ content: "Can't bet a bot.", ephemeral: true });
    return;
  }
  if (!(await isAllowed(i.user.id)) || !(await isAllowed(target.id))) {
    await i.reply({
      content: "One of you isn't on the allowlist for this server.",
      ephemeral: true,
    });
    return;
  }

  const { betId, shortcode } = await proposeBet({
    guildId: i.guildId,
    channelId: i.channelId,
    challengerId: i.user.id,
    accepterId: target.id,
    amount: dollarsToAtoms(amount),
    description,
    tokenMint: mockUsdcMint.toBase58(),
  });

  const challengerRel = await reliabilityLabel(i.user.id);
  const accepterRel = await reliabilityLabel(target.id);
  const card = renderBetCard({
    betId,
    challenger: i.user.toString(),
    accepter: target.toString(),
    amount,
    description,
    status: "proposed",
    shortcode,
    challengerReliability: challengerRel,
    accepterReliability: accepterRel,
  });
  await i.reply({
    content: `${target}, you've been challenged. Bet code: \`${shortcode}\``,
    embeds: [card.embed],
    components: [card.proposeRow(betId)],
  });
  const msg = await i.fetchReply();
  await setAnnounceMessageId(betId, msg.id);
}

export async function handleMyBets(i: ChatInputCommandInteraction) {
  const rows = await listActiveBetsFor(i.user.id);
  if (rows.length === 0) {
    await i.reply({ content: "You have no active bets.", ephemeral: true });
    return;
  }
  const lines = rows.map(formatBet);
  await i.reply({
    content: `Your active bets:\n${lines.join("\n")}`,
    ephemeral: true,
  });
}

/** Resolves a string from a bet_id slash option to a bigint betId. Accepts
 *  either the full numeric id or a 6-char shortcode. Replies with an error
 *  message and returns null if neither matches. */
async function resolveBetIdFromInput(
  i: ChatInputCommandInteraction,
  raw: string,
): Promise<bigint | null> {
  const bet = await findBetByIdOrShortcode(raw);
  if (!bet) {
    await (i.replied || i.deferred
      ? i.editReply(`Bet \`${raw}\` not found.`)
      : i.reply({ content: `Bet \`${raw}\` not found.`, ephemeral: true }));
    return null;
  }
  return bet.id;
}

export async function handleResolve(i: ChatInputCommandInteraction) {
  const betIdStr = i.options.getString("bet_id", true);
  const winner = i.options.getUser("winner", true);
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const outcome = await claimWinner(betId, i.user.id, winner.id);
    if (outcome.outcome === "resolved") {
      await i.editReply(
        `✅ Resolved. Winner: ${winner}. tx: https://explorer.solana.com/tx/${outcome.sig}?cluster=devnet`,
      );
      await sendResolutionDms(i, betId);
    } else if (outcome.outcome === "disputed") {
      await i.editReply(
        `⚠️ Both parties picked different winners — bet is now disputed. An admin will step in.`,
      );
    } else {
      await i.editReply(
        `Your vote for ${winner} has been recorded. Waiting for the other side.`,
      );
    }
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleCancel(i: ChatInputCommandInteraction) {
  const betIdStr = i.options.getString("bet_id", true);
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const sig = await refundBet(betId);
    await i.editReply(
      `↩️ Refunded. tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    );
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleAdminResolve(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) {
    await i.reply({ content: "Admin only.", ephemeral: true });
    return;
  }
  const betIdStr = i.options.getString("bet_id", true);
  const winner = i.options.getUser("winner", true);
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const outcome = await adminResolve(betId, i.user.id, winner.id);
    await i.editReply(
      `✅ Admin resolved. Winner: ${winner}. tx: https://explorer.solana.com/tx/${outcome.sig}?cluster=devnet`,
    );
    await sendResolutionDms(i, betId);
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleReconcile(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) {
    await i.reply({ content: "Admin only.", ephemeral: true });
    return;
  }
  const betIdStr = i.options.getString("bet_id", true);
  await i.deferReply({ ephemeral: true });
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const result = await reconcileBet(betId);
    if (result.changed) {
      await i.editReply(
        `Reconciled. Patch: \`${JSON.stringify(result.patch)}\``,
      );
    } else {
      await i.editReply(`No changes — DB already matches on-chain state.`);
    }
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleStatus(i: ChatInputCommandInteraction) {
  const raw = i.options.getString("bet_id", true);
  const bet = await findBetByIdOrShortcode(raw);
  if (!bet) {
    await i.reply({ content: `Bet \`${raw}\` not found.`, ephemeral: true });
    return;
  }
  const tokenAmount = formatAmount(BigInt(bet.amount));
  const challengerRel = await reliabilityLabel(bet.challengerId);
  const accepterRel = await reliabilityLabel(bet.accepterId);
  const lines: string[] = [
    `**Bet #${bet.shortcode}** — _${bet.status}_`,
    `> ${bet.description}`,
    `<@${bet.challengerId}>${challengerRel ? ` (${challengerRel})` : ""} vs <@${bet.accepterId}>${accepterRel ? ` (${accepterRel})` : ""}`,
    `${tokenAmount} mUSDC each · pot ${(Number(BigInt(bet.amount)) / 1e6 * 2).toFixed(2)} mUSDC`,
  ];
  if (bet.deadline) {
    const deadlineUnix = Math.floor(new Date(bet.deadline).getTime() / 1000);
    lines.push(`Settles: <t:${deadlineUnix}:R> (<t:${deadlineUnix}:F>)`);
  }
  if (bet.status === "pending" || bet.status === "accepted") {
    lines.push(
      `Deposits: challenger ${bet.challengerDeposited ? "✅" : "⏳"} · accepter ${bet.accepterDeposited ? "✅" : "⏳"}`,
    );
  }
  if (bet.winnerId) {
    lines.push(`Winner: <@${bet.winnerId}>`);
  }
  if (bet.resolutionTxSig) {
    lines.push(
      `Tx: [explorer](https://explorer.solana.com/tx/${bet.resolutionTxSig}?cluster=devnet)`,
    );
  }
  if (bet.challengerClaimsWinner || bet.accepterClaimsWinner) {
    lines.push(
      `Claims — challenger: ${bet.challengerClaimsWinner ? `<@${bet.challengerClaimsWinner}>` : "—"} · accepter: ${bet.accepterClaimsWinner ? `<@${bet.accepterClaimsWinner}>` : "—"}`,
    );
  }
  await i.reply({ content: lines.join("\n") });
}

export async function handleLeaderboard(i: ChatInputCommandInteraction) {
  const by = i.options.getString("by") ?? "won";
  // Fetch a generous slice (top 100 by winnings) so re-ranking in JS isn't
  // truncated for the wagered / winrate views. At MVP scale this is fine;
  // when the user count grows, push the ORDER BY into the SQL via a `by`
  // arg in leaderboardData.
  const rows = await leaderboardData({
    guildId: i.guildId ?? undefined,
    limit: 100,
  });
  if (rows.length === 0) {
    await i.reply({
      content: "No completed bets yet — be the first.",
      ephemeral: true,
    });
    return;
  }
  type Row = (typeof rows)[number];
  let sortedRows: Row[] = [...rows];
  if (by === "wagered") {
    sortedRows.sort((a, b) =>
      a.totalWagered > b.totalWagered ? -1 : a.totalWagered < b.totalWagered ? 1 : 0,
    );
  } else if (by === "winrate") {
    sortedRows = sortedRows.filter((r) => r.bets >= 5);
    sortedRows.sort((a, b) => b.wins / b.bets - a.wins / a.bets);
  }
  // Default 'won' is already sorted by the SQL ORDER BY.
  const lines = sortedRows.slice(0, 10).map((r, idx) => {
    const won = (Number(r.totalWon) / 1e6).toFixed(2);
    const wagered = (Number(r.totalWagered) / 1e6).toFixed(2);
    const winRate = r.bets > 0 ? Math.round((r.wins / r.bets) * 100) : 0;
    return `**${idx + 1}.** <@${r.discordId}> — won ${won} mUSDC · wagered ${wagered} · ${winRate}% win rate (${r.bets} bets)`;
  });
  if (lines.length === 0) {
    await i.reply({
      content: "No-one qualifies (need 5+ bets for win rate).",
      ephemeral: true,
    });
    return;
  }
  const heading =
    by === "won"
      ? "🏆 Top winnings"
      : by === "wagered"
        ? "💵 Top wagered"
        : "📊 Top win rate";
  await i.reply({ content: `${heading}\n${lines.join("\n")}` });
}

export async function handleHelp(i: ChatInputCommandInteraction) {
  await i.reply({
    ephemeral: true,
    content: [
      "**cozy-bet** — peer-to-peer escrow on Solana",
      "",
      "**Flow**",
      "1. `/linkwallet` — connect your Solana wallet (one-time).",
      "2. `/saybet @user <amount> <description>` — challenge someone.",
      "3. They click Accept. Both get a DM link to deposit mUSDC.",
      "4. Once both deposit, the bet is locked. Decide the winner with `/resolve`.",
      "5. When both sides agree on a winner, payout happens on-chain automatically.",
      "",
      "**Commands**",
      "• `/saybet` · `/mybets` · `/resolve` · `/cancel`",
      "• `/linkwallet` · `/balance` · `/help`",
      "",
      "Disputes: when you and your counterpart pick different winners, the bet freezes until an admin resolves it via `/adminresolve`.",
    ].join("\n"),
  });
}

export async function handleBalance(i: ChatInputCommandInteraction) {
  const user = await getUser(i.user.id);
  if (!user?.walletPubkey) {
    await i.reply({
      content: "You haven't linked a wallet yet. Run `/linkwallet`.",
      ephemeral: true,
    });
    return;
  }
  const owner = new PublicKey(user.walletPubkey);
  const ata = getAssociatedTokenAddressSync(mockUsdcMint, owner);
  let amountAtoms = 0n;
  try {
    const acc = await getAccount(connection, ata);
    amountAtoms = acc.amount;
  } catch (e) {
    if (!(e instanceof TokenAccountNotFoundError)) {
      await i.reply({
        content: `Error fetching balance: ${(e as Error)?.message ?? e}`,
        ephemeral: true,
      });
      return;
    }
  }
  const amount = (Number(amountAtoms) / 1e6).toFixed(2);
  const sol = await connection.getBalance(owner);
  await i.reply({
    content: `Wallet: \`${user.walletPubkey}\`\nmUSDC: **${amount}**\nSOL: ${(sol / 1e9).toFixed(4)}`,
    ephemeral: true,
  });
}

export async function handleLinkWallet(i: ChatInputCommandInteraction) {
  const existing = await getUser(i.user.id);
  if (existing?.walletPubkey) {
    await i.reply({
      content: `Already linked to \`${existing.walletPubkey}\`. Re-linking will overwrite.`,
      ephemeral: true,
    });
  }
  const { url } = await createWalletLinkSession(i.user.id);
  await i.reply({
    content: `Open this to link your wallet (expires in 15 min): ${url}`,
    ephemeral: true,
  });
}

export async function handleAccept(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  const bet = await getBet(betId);
  if (!bet) return i.followUp({ content: "Bet not found.", ephemeral: true });
  if (bet.accepterId !== i.user.id) {
    return i.followUp({ content: "You're not the accepter.", ephemeral: true });
  }

  // Ensure both wallets are linked; if not, send link prompts.
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  if (!challenger?.walletPubkey) {
    const { url } = await createWalletLinkSession(bet.challengerId);
    try {
      const u = await i.client.users.fetch(bet.challengerId);
      await u.send(`Link your wallet to fund your bet: ${url}`);
    } catch {}
  }
  if (!accepter?.walletPubkey) {
    const { url } = await createWalletLinkSession(bet.accepterId);
    try {
      await i.user.send(`Link your wallet to fund your bet: ${url}`);
    } catch {}
  }

  await acceptBet(betId, i.user.id);

  // If both wallets are linked, initialize on-chain + send fund links.
  const c2 = await getUser(bet.challengerId);
  const a2 = await getUser(bet.accepterId);
  if (c2?.walletPubkey && a2?.walletPubkey) {
    try {
      await initializeOnChain(betId);
      await sendFundLinks(i, betId);
    } catch (e: any) {
      await i.followUp({
        content: `Failed to initialize on-chain: ${e?.message ?? e}`,
        ephemeral: true,
      });
      return;
    }
  }

  await updateAnnouncement(i.client, betId);
}

async function sendFundLinks(i: ButtonInteraction, betId: bigint) {
  const bet = await getBet(betId);
  if (!bet) return;
  const tokenAmount = formatAmount(BigInt(bet.amount));
  const fundUrl = `${process.env.WEB_PUBLIC_URL}/fund/${betId}`;
  // Repeat the verbatim canonical terms in the deposit DM so neither party
  // can later claim they "didn't know" what they were agreeing to. This is
  // the second of three repetitions (preview embed → deposit DM → resolve DM).
  const dmContent = [
    `**Deposit ${tokenAmount} mUSDC** to fund bet \`${bet.shortcode}\`:`,
    fundUrl,
    "",
    "⚠️  What you're agreeing to:",
    `> ${bet.description}`,
    "",
    "By depositing you confirm these terms. No refunds after deposit unless both parties agree to cancel or draw.",
  ].join("\n");
  for (const uid of [bet.challengerId, bet.accepterId]) {
    try {
      const u = await i.client.users.fetch(uid);
      await u.send(dmContent);
    } catch {}
  }
}

/** DM both participants when a bet resolves, with the verbatim terms repeated
 *  one final time so the resolution rationale is unambiguous. Third repetition
 *  in the outcome-contract chain. */
async function sendResolutionDms(
  i: ButtonInteraction | ChatInputCommandInteraction,
  betId: bigint,
) {
  const bet = await getBet(betId);
  if (!bet) return;
  const winner = bet.winnerId ? `<@${bet.winnerId}>` : "(unknown)";
  const txLink = bet.resolutionTxSig
    ? `https://explorer.solana.com/tx/${bet.resolutionTxSig}?cluster=devnet`
    : null;
  const lines = [
    `**Bet \`${bet.shortcode}\` resolved.** Winner: ${winner}.`,
    "",
    "Terms:",
    `> ${bet.description}`,
  ];
  if (txLink) lines.push("", `On-chain: ${txLink}`);
  const dmContent = lines.join("\n");
  for (const uid of [bet.challengerId, bet.accepterId]) {
    try {
      const u = await i.client.users.fetch(uid);
      await u.send(dmContent);
    } catch {}
  }
}

export async function handleDecline(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  const bet = await getBet(betId);
  if (!bet) return;
  if (bet.accepterId !== i.user.id) {
    return i.followUp({ content: "Only the challenged user can decline.", ephemeral: true });
  }
  await declineBet(betId, i.user.id);
  await updateAnnouncement(i.client, betId);
}

