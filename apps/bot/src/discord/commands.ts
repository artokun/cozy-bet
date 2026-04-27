import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { formatAmount, formatBet, renderBetCard } from "./render.js";
import { chainExplorerTxUrl, type Chain } from "../chain.js";
import {
  acceptBet,
  adminResolve,
  agreeCancel,
  agreeCounter,
  claimDraw,
  claimOpenBet,
  claimWinner,
  createRematch,
  createWalletLinkSession,
  declineBet,
  denyCancel,
  denyCounter,
  findBetByIdOrShortcode,
  getBet,
  getUser,
  initializeOnChain,
  isAllowed,
  leaderboardData,
  listActiveBetsFor,
  proposeBet,
  proposeCounter,
  reconcileBet,
  reliabilityLabel,
  requestArbiter,
  requestCancel,
  setAnnounceMessageId,
} from "../flows.js";
import { adminDiscordIds, isAdmin } from "../env.js";
import { connection, mockUsdcMint } from "../solana.js";
import * as evm from "../evm.js";
import { safeChannelSend, updateAnnouncement } from "./announce.js";
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
  .setDescription("Challenge a user (or open the bet to anyone)")
  .addNumberOption((o) =>
    o
      .setName("amount")
      .setDescription("amount in USDC (min 1)")
      .setMinValue(1)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("description")
      .setDescription("what is the bet?")
      .setMaxLength(200)
      .setRequired(true),
  )
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("who you want to bet (omit to open to anyone)"),
  )
  .addStringOption((o) =>
    o
      .setName("chain")
      .setDescription("settlement chain (default: your preferred chain)")
      .addChoices(
        { name: "Solana", value: "solana" },
        { name: "Base", value: "base" },
      ),
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

export const drawCmd = new SlashCommandBuilder()
  .setName("draw")
  .setDescription("Claim the bet was a draw (both sides must agree)")
  .addStringOption((o) =>
    o
      .setName("bet_id")
      .setDescription("bet id or shortcode")
      .setRequired(true),
  );

export const counterCmd = new SlashCommandBuilder()
  .setName("counter")
  .setDescription("Counter-propose new terms before the other side accepts")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id or shortcode").setRequired(true),
  )
  .addNumberOption((o) =>
    o.setName("amount").setDescription("new amount in mUSDC").setMinValue(1),
  )
  .addStringOption((o) =>
    o
      .setName("description")
      .setDescription("new bet description")
      .setMaxLength(200),
  );

export const linkwallet = new SlashCommandBuilder()
  .setName("linkwallet")
  .setDescription("Link a wallet to your Discord account")
  .addStringOption((o) =>
    o
      .setName("chain")
      .setDescription("which chain (default: Solana)")
      .addChoices(
        { name: "Solana", value: "solana" },
        { name: "Base", value: "base" },
      ),
  );

export const adminresolve = new SlashCommandBuilder()
  .setName("adminresolve")
  .setDescription("(admin) Force-resolve a disputed or stuck bet")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  )
  .addUserOption((o) =>
    o.setName("winner").setDescription("winning user").setRequired(true),
  );

export const requestArbiterCmd = new SlashCommandBuilder()
  .setName("requestarbiter")
  .setDescription(
    "Escalate a Funded or Disputed bet to an admin arbiter (max($100, 1% pot) fee from pot)",
  )
  .addStringOption((o) =>
    o
      .setName("bet_id")
      .setDescription("bet id or shortcode")
      .setRequired(true),
  );

export const reconcile = new SlashCommandBuilder()
  .setName("reconcile")
  .setDescription("(admin) Re-sync a bet's DB state from on-chain truth")
  .addStringOption((o) =>
    o.setName("bet_id").setDescription("bet id").setRequired(true),
  );

export const previewTermsCmd = new SlashCommandBuilder()
  .setName("preview-terms")
  .setDescription("(admin) Try the LLM disambig on a phrase without creating a bet")
  .addStringOption((o) =>
    o.setName("phrase").setDescription("the bet phrase").setRequired(true),
  )
  .addUserOption((o) =>
    o.setName("user").setDescription("hypothetical accepter (for context)"),
  );

export const helpCmd = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use cozy-bet");

export const balanceCmd = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Show your USDC balance on each linked chain");

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
  drawCmd.toJSON(),
  counterCmd.toJSON(),
  cancelCmd.toJSON(),
  linkwallet.toJSON(),
  balanceCmd.toJSON(),
  helpCmd.toJSON(),
  statusCmd.toJSON(),
  leaderboardCmd.toJSON(),
  adminresolve.toJSON(),
  reconcile.toJSON(),
  previewTermsCmd.toJSON(),
  requestArbiterCmd.toJSON(),
];

export async function handleSaybet(i: ChatInputCommandInteraction) {
  if (!i.guildId) {
    await i.reply({ content: "Use this in a server, not DMs.", ephemeral: true });
    return;
  }
  const target = i.options.getUser("user");
  const amount = i.options.getNumber("amount", true);
  const description = i.options.getString("description", true);
  const chainOpt = i.options.getString("chain") as
    | "solana"
    | "base"
    | null;
  if (target && target.id === i.user.id) {
    await i.reply({ content: "You can't bet yourself.", ephemeral: true });
    return;
  }
  if (target && target.bot) {
    await i.reply({ content: "Can't bet a bot.", ephemeral: true });
    return;
  }
  if (!(await isAllowed(i.user.id))) {
    await i.reply({
      content: "You're not on the allowlist for this server.",
      ephemeral: true,
    });
    return;
  }
  if (target && !(await isAllowed(target.id))) {
    await i.reply({
      content: `${target} isn't on the allowlist for this server.`,
      ephemeral: true,
    });
    return;
  }

  // Defer BEFORE the LLM call — disambig + DB write can take >3s.
  await i.deferReply();

  const proposed = await proposeBet({
    guildId: i.guildId,
    channelId: i.channelId,
    challengerId: i.user.id,
    accepterId: target?.id ?? null,
    amount: dollarsToAtoms(amount),
    description,
    tokenMint: mockUsdcMint.toBase58(),
    chain: chainOpt ?? undefined,
    challengerTag: i.user.username,
    accepterTag: target?.username,
  });
  if (!proposed.ok) {
    const msg =
      proposed.reason === "no_wallet"
        ? `${proposed.detail}`
        : `Couldn't auto-clarify those terms: \`${proposed.detail}\`. Try rewording the description so the winning condition is unambiguous (who, when, where, how it's verified).`;
    await i.editReply({ content: msg });
    return;
  }
  const { betId, shortcode, termsCanonical } = proposed;

  // Show the canonical (LLM-disambig) sentence in the embed when it differs
  // from the user's verbatim. The verbatim quote stays sacred above it.
  const showCanonical =
    termsCanonical.trim() !== description.trim() ? termsCanonical : null;

  const challengerRel = await reliabilityLabel(i.user.id);
  const accepterRel = target ? await reliabilityLabel(target.id) : null;
  const card = renderBetCard({
    betId,
    challenger: i.user.toString(),
    accepter: target?.toString() ?? "_(open — anyone can claim)_",
    amount,
    description,
    canonical: showCanonical,
    status: "proposed",
    shortcode,
    settlementChain: proposed.chain,
    challengerReliability: challengerRel,
    accepterReliability: accepterRel,
  });
  const chainLabel = proposed.chain === "solana" ? "Solana" : "Base";
  const replyContent = target
    ? `${target}, you've been challenged. Bet code: \`${shortcode}\` (${chainLabel})`
    : `⚔️ <@${i.user.id}> is throwing it out there for **${amount} USDC on ${chainLabel}** — first mandem to tap Accept takes the other side. Bet code: \`${shortcode}\``;
  await i.editReply({
    content: replyContent,
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
      const bet = await getBet(betId);
      const url = chainExplorerTxUrl(bet?.chain as Chain, outcome.sig);
      await i.editReply(
        `✅ Resolved. Winner: ${winner}. tx: ${url}`,
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

export async function handleDraw(i: ChatInputCommandInteraction) {
  const betIdStr = i.options.getString("bet_id", true);
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const outcome = await claimDraw(betId, i.user.id);
    if (outcome.outcome === "drawn") {
      const bet = await getBet(betId);
      const url = chainExplorerTxUrl(bet?.chain as Chain, outcome.sig);
      await i.editReply(
        `🤝 Draw confirmed. Both stakes refunded. tx: ${url}`,
      );
      await sendResolutionDms(i, betId);
    } else {
      await i.editReply(
        `Your draw vote has been recorded. Waiting for the other side to also call /draw — or for either side to /resolve with a specific winner.`,
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
    const bet = await requestCancel(betId, i.user.id);
    if (!bet) {
      await i.editReply("Bet not found after request.");
      return;
    }
    const counterpartyId =
      bet.challengerId === i.user.id ? bet.accepterId : bet.challengerId;
    if (!counterpartyId) {
      await i.editReply("Bet has no counterparty to ask for agreement.");
      return;
    }
    const counterparty = `<@${counterpartyId}>`;
    const dmContent = `<@${i.user.id}> requested to cancel bet \`${bet.shortcode}\`:\n> ${bet.description}\n\nAgree → both sides refunded. Deny → bet stays active.`;
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel-agree:${bet.id}`)
          .setLabel("✅ Agree to cancel")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cancel-deny:${bet.id}`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger),
      ),
    ];
    let dmDelivered = false;
    try {
      const u = await i.client.users.fetch(counterpartyId);
      await u.send({ content: dmContent, components });
      dmDelivered = true;
    } catch {}
    // Fallback: post the request + buttons in the bet's channel so the
    // counterparty can act even with DMs disabled. safeChannelSend logs a
    // 'channel_fallback' event so we can detect chronic delivery problems.
    if (!dmDelivered) {
      try {
        await safeChannelSend(i.client, {
          channelId: bet.channelId,
          payload: {
            content: `${counterparty} (couldn't DM you) — ${dmContent}`,
            components,
          },
          fallbackRecipients: [counterpartyId],
          betId: bet.id,
        });
      } catch {}
    }
    await i.editReply(
      `🛑 Cancel requested for \`${bet.shortcode}\`. ${counterparty} has 24h to agree or deny${dmDelivered ? "" : " (DM failed → posted in channel)"}.`,
    );
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleCounter(i: ChatInputCommandInteraction) {
  const betIdStr = i.options.getString("bet_id", true);
  const newAmountDollars = i.options.getNumber("amount");
  const newDescription = i.options.getString("description");
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  if (newAmountDollars === null && newDescription === null) {
    await i.editReply("Provide at least one of `amount` or `description`.");
    return;
  }
  try {
    const newAmountAtoms =
      newAmountDollars !== null ? dollarsToAtoms(newAmountDollars) : null;
    const bet = await proposeCounter({
      betId,
      requesterId: i.user.id,
      newAmount: newAmountAtoms,
      newDescription,
    });
    if (!bet) {
      await i.editReply("Bet not found after counter.");
      return;
    }
    const counterpartyId =
      bet.challengerId === i.user.id ? bet.accepterId : bet.challengerId;
    if (!counterpartyId) {
      await i.editReply("No counterparty to counter against (open bet?).");
      return;
    }
    const lines = [`<@${i.user.id}> countered bet \`${bet.shortcode}\`:`];
    if (newAmountAtoms !== null) {
      lines.push(
        `· stake: ${formatAmount(BigInt(bet.amount))} → **${formatAmount(newAmountAtoms)}** mUSDC`,
      );
    }
    if (newDescription !== null) {
      lines.push(`· description:`);
      lines.push(`> was: ${bet.description}`);
      lines.push(`> now: ${newDescription}`);
    }
    lines.push("");
    lines.push("Agree → terms updated. Deny → terms stay as they were.");
    const dmContent = lines.join("\n");
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`counter-agree:${bet.id}`)
          .setLabel("✅ Agree to counter")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`counter-deny:${bet.id}`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger),
      ),
    ];
    let dmDelivered = false;
    try {
      const u = await i.client.users.fetch(counterpartyId);
      await u.send({ content: dmContent, components });
      dmDelivered = true;
    } catch {}
    if (!dmDelivered) {
      try {
        await safeChannelSend(i.client, {
          channelId: bet.channelId,
          payload: {
            content: `<@${counterpartyId}> (couldn't DM) — ${dmContent}`,
            components,
          },
          fallbackRecipients: [counterpartyId],
          betId: bet.id,
        });
      } catch {}
    }
    await i.editReply(
      `↗️ Counter proposed for \`${bet.shortcode}\`. <@${counterpartyId}> can agree or deny${dmDelivered ? "" : " (DM failed → posted in channel)"}.`,
    );
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleCounterAgree(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  try {
    const bet = await agreeCounter(betId, i.user.id);
    await i.editReply({ components: [] });
    await i.followUp({
      content: bet
        ? `✅ Counter accepted on \`${bet.shortcode}\`. New terms locked in.`
        : `✅ Counter accepted.`,
      ephemeral: false,
    });
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.followUp({
      content: `Error: ${e?.message ?? String(e)}`,
      ephemeral: true,
    });
  }
}

export async function handleCounterDeny(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  try {
    await denyCounter(betId, i.user.id);
    await i.editReply({ components: [] });
    await i.followUp({
      content: `❌ Counter denied — original terms stand.`,
      ephemeral: false,
    });
  } catch (e: any) {
    await i.followUp({
      content: `Error: ${e?.message ?? String(e)}`,
      ephemeral: true,
    });
  }
}

export async function handleCancelAgree(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  try {
    const { sig } = await agreeCancel(betId, i.user.id);
    const bet = await getBet(betId);
    const url = chainExplorerTxUrl(bet?.chain as Chain, sig);
    await i.editReply({ components: [] });
    await i.followUp({
      content: `↩️ Both sides refunded. tx: ${url}`,
      ephemeral: false,
    });
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.followUp({
      content: `Error: ${e?.message ?? String(e)}`,
      ephemeral: true,
    });
  }
}

export async function handleCancelDeny(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  try {
    await denyCancel(betId, i.user.id);
    await i.editReply({ components: [] });
    await i.followUp({
      content: `❌ Cancel denied — bet stays active.`,
      ephemeral: false,
    });
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.followUp({
      content: `Error: ${e?.message ?? String(e)}`,
      ephemeral: true,
    });
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
    const bet = await getBet(betId);
    const url = chainExplorerTxUrl(bet?.chain as Chain, outcome.sig);
    await i.editReply(
      `✅ Admin resolved. Winner: ${winner}. tx: ${url}`,
    );
    await sendResolutionDms(i, betId);
    await updateAnnouncement(i.client, betId);
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleRequestArbiter(i: ChatInputCommandInteraction) {
  const betIdStr = i.options.getString("bet_id", true);
  await i.deferReply();
  const betId = await resolveBetIdFromInput(i, betIdStr);
  if (betId === null) return;
  try {
    const result = await requestArbiter(betId, i.user.id);
    const bet = result.bet;
    const otherSideId =
      i.user.id === bet.challengerId ? bet.accepterId : bet.challengerId;
    if (result.alreadyRequested) {
      await i.editReply(
        `Arbiter was already requested for bet \`${bet.shortcode}\` on <t:${Math.floor(
          new Date(bet.arbiterRequestedAt!).getTime() / 1000,
        )}:R>. An admin will pick this up.`,
      );
    } else {
      await i.editReply(
        `🛎️ Arbiter requested for bet \`${bet.shortcode}\`. An admin will review the case. The arbiter fee is **max($100, 1% of pot)** taken from the pot before payout.`,
      );

      // Channel notice so the counterparty + bystanders see the escalation.
      try {
        await safeChannelSend(i.client, {
          channelId: bet.channelId,
          payload: {
            content: [
              `⚠️ <@${i.user.id}> has requested an arbiter on bet \`${bet.shortcode}\`.`,
              otherSideId ? `<@${otherSideId}> — heads up.` : null,
              `An admin will review the dispute. Arbiter fee: max($100, 1% pot) from the pot.`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
          fallbackRecipients: [bet.challengerId, otherSideId].filter(
            Boolean,
          ) as string[],
          betId: bet.id,
        });
      } catch {}

      // DM every admin so the case lands in their inbox immediately.
      const admins = adminDiscordIds();
      const txLink = bet.resolutionTxSig
        ? chainExplorerTxUrl(bet.chain as Chain, bet.resolutionTxSig)
        : null;
      const dmBody = [
        `🛎️ **Arbiter requested** on bet \`${bet.shortcode}\``,
        `Chain: ${bet.chain === "solana" ? "Solana" : "Base"}`,
        `Stake: ${formatAmount(BigInt(bet.amount))} USDC each`,
        `Challenger: <@${bet.challengerId}>${bet.challengerClaimsWinner ? ` (claims winner: <@${bet.challengerClaimsWinner}>)` : ""}`,
        `Accepter: <@${bet.accepterId ?? "?"}>${bet.accepterClaimsWinner ? ` (claims winner: <@${bet.accepterClaimsWinner}>)` : ""}`,
        ``,
        `Terms:`,
        `> ${bet.description}`,
        bet.termsCanonical && bet.termsCanonical !== bet.description
          ? `Canonical: ${bet.termsCanonical}`
          : null,
        ``,
        `To resolve: \`/adminresolve bet_id:${bet.shortcode} winner:@user\``,
        txLink ? `Tx: ${txLink}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      for (const adminId of admins) {
        try {
          const u = await i.client.users.fetch(adminId);
          await u.send(dmBody);
        } catch {}
      }
    }
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
  const accepterRel = bet.accepterId
    ? await reliabilityLabel(bet.accepterId)
    : null;
  const accepterTag = bet.accepterId
    ? `<@${bet.accepterId}>${accepterRel ? ` (${accepterRel})` : ""}`
    : "_(open — first to claim)_";
  const lines: string[] = [
    `**Bet #${bet.shortcode}** — _${bet.status}_`,
    `> ${bet.description}`,
    `<@${bet.challengerId}>${challengerRel ? ` (${challengerRel})` : ""} vs ${accepterTag}`,
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
      `Tx: [explorer](${chainExplorerTxUrl(bet.chain as Chain, bet.resolutionTxSig)})`,
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

export async function handlePreviewTerms(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) {
    await i.reply({ content: "Admin only.", ephemeral: true });
    return;
  }
  const phrase = i.options.getString("phrase", true);
  const target = i.options.getUser("user");
  await i.deferReply({ ephemeral: true });
  try {
    const { disambig, termsHashOf } = await import("../llm.js");
    const result = await disambig({
      userPhrase: phrase,
      challengerTag: i.user.username,
      accepterTag: target?.username ?? "the other side",
      todayIso: new Date().toISOString().slice(0, 10),
    });
    if (result.kind === "skipped") {
      await i.editReply(
        `LLM not configured (ANTHROPIC_API_KEY unset). Verbatim passthrough:\n> ${phrase}`,
      );
      return;
    }
    if (result.kind === "unresolvable") {
      await i.editReply(`Cannot auto-clarify: \`${result.reason}\``);
      return;
    }
    const hash = Buffer.from(termsHashOf(result.canonical)).toString("hex");
    await i.editReply(
      [
        `**User phrase (verbatim, sacred):**`,
        `> ${phrase}`,
        ``,
        `**Canonical (LLM disambig):**`,
        `> ${result.canonical}`,
        ``,
        `**termsHash (keccak256):** \`0x${hash}\``,
      ].join("\n"),
    );
  } catch (e: any) {
    await i.editReply(`Error: ${e?.message ?? String(e)}`);
  }
}

export async function handleHelp(i: ChatInputCommandInteraction) {
  await i.reply({
    ephemeral: true,
    content: [
      "**cozy-bet** — bridging online larps with real stakes.",
      "",
      "**Flow**",
      "1. `/linkwallet [chain]` — link your Solana or Base wallet (one-time per chain).",
      "2. `/saybet @user <amount> <description> [chain]` — challenge someone. Omit `@user` to leave it open for anyone. Defaults to your preferred chain.",
      "3. They click Accept. Both get a DM link to deposit USDC.",
      "4. Once both deposit, bet's locked. Decide the winner with `/resolve`. Or `/draw` if you both agree it's a tie.",
      "5. When both sides match on the same winner, the contract pays out on-chain.",
      "",
      "**Bet commands**",
      "• `/saybet` — start a challenge",
      "• `/counter <bet_id> [amount] [description]` — counter-propose new terms before either side accepts",
      "• `/resolve <bet_id> @winner` — claim a winner",
      "• `/draw <bet_id>` — both agree it's a tie",
      "• `/cancel <bet_id>` — request mutual cancel (counterparty must agree)",
      "",
      "**Info commands**",
      "• `/status <bet_id>` — full detail on a bet",
      "• `/mybets` — your active bets",
      "• `/leaderboard [by:won|wagered|winrate]` — server leaderboard",
      "• `/balance` — your wallet + mUSDC balance",
      "• `/linkwallet` — link or relink",
      "• `/help` — this message",
      "",
      "**Buttons / DMs you might see**",
      "• ✅ Accept / ❌ Decline — on every challenge embed",
      "• 🎲 Double or Nothing — DMed to the loser of a resolved bet",
      "• ✅ Agree / ❌ Deny — for /counter and /cancel proposals",
      "",
      "**Disputes**",
      "• Different winner claims → bet freezes (Disputed). Either side can `/requestarbiter <bet_id>` to escalate to an admin — costs max($100, 1% of pot) from the pot to settle.",
      "• Admins use `/adminresolve <bet_id> @winner` to break ties.",
      "",
      "**Note on bet IDs:** every bet has a 6-char shortcode like `K7M2RX` shown in the embed. Use that anywhere a `<bet_id>` is asked for.",
    ].join("\n"),
  });
}

export async function handleBalance(i: ChatInputCommandInteraction) {
  const user = await getUser(i.user.id);
  if (!user?.walletPubkey && !user?.evmAddress) {
    await i.reply({
      content:
        "You haven't linked any wallet yet. Run `/linkwallet` (Solana or Base).",
      ephemeral: true,
    });
    return;
  }
  await i.deferReply({ ephemeral: true });

  const lines: string[] = [];

  if (user.walletPubkey) {
    try {
      const owner = new PublicKey(user.walletPubkey);
      const ata = getAssociatedTokenAddressSync(mockUsdcMint, owner);
      let usdcAtoms = 0n;
      try {
        const acc = await getAccount(connection, ata);
        usdcAtoms = acc.amount;
      } catch (e) {
        if (!(e instanceof TokenAccountNotFoundError)) throw e;
      }
      const usdc = (Number(usdcAtoms) / 1e6).toFixed(2);
      const sol = await connection.getBalance(owner);
      lines.push(
        `**Solana** \`${user.walletPubkey}\``,
        `· mUSDC: **${usdc}** · SOL: ${(sol / 1e9).toFixed(4)}`,
      );
    } catch (e: unknown) {
      lines.push(
        `**Solana** \`${user.walletPubkey}\``,
        `· _(error: ${e instanceof Error ? e.message : String(e)})_`,
      );
    }
  }

  if (user.evmAddress) {
    try {
      const usdcAtoms = await evm.fetchUsdcBalance(
        user.evmAddress as `0x${string}`,
      );
      if (usdcAtoms === null) {
        lines.push(
          `**Base** \`${user.evmAddress}\``,
          `· _(EVM adapter not configured)_`,
        );
      } else {
        const usdc = (Number(usdcAtoms) / 1e6).toFixed(2);
        lines.push(
          `**Base** \`${user.evmAddress}\``,
          `· USDC: **${usdc}**`,
        );
      }
    } catch (e: unknown) {
      lines.push(
        `**Base** \`${user.evmAddress}\``,
        `· _(error: ${e instanceof Error ? e.message : String(e)})_`,
      );
    }
  }

  await i.editReply({ content: lines.join("\n") });
}

export async function handleLinkWallet(i: ChatInputCommandInteraction) {
  const chain = (i.options.getString("chain") as "solana" | "base" | null) ??
    "solana";
  const existing = await getUser(i.user.id);
  const already =
    chain === "solana" ? existing?.walletPubkey : existing?.evmAddress;
  if (already) {
    await i.reply({
      content: `Already linked your ${chain === "solana" ? "Solana" : "Base"} wallet to \`${already}\`. Re-linking will overwrite.`,
      ephemeral: true,
    });
  }
  const { url: baseUrl } = await createWalletLinkSession(i.user.id);
  // Append chain so the web app knows whether to render Phantom or
  // wagmi/Coinbase Smart Wallet on the link page.
  const url = `${baseUrl}?chain=${chain}`;
  await i.reply({
    content: `Open this to link your **${chain === "solana" ? "Solana" : "Base"}** wallet (expires in 15 min): ${url}`,
    ephemeral: true,
  });
}

export async function handleAccept(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  const bet = await getBet(betId);
  if (!bet) return i.followUp({ content: "Bet not found.", ephemeral: true });

  // Open bet → atomically claim the accepter slot.
  if (bet.isOpen && bet.accepterId === null) {
    if (bet.challengerId === i.user.id) {
      return i.followUp({
        content: "You can't accept your own challenge.",
        ephemeral: true,
      });
    }
    if (!(await isAllowed(i.user.id))) {
      return i.followUp({
        content: "You're not on the allowlist for this server.",
        ephemeral: true,
      });
    }
    const claimed = await claimOpenBet(betId, i.user.id);
    if (!claimed) {
      return i.followUp({
        content: "Someone else just claimed this bet first.",
        ephemeral: true,
      });
    }
  } else if (bet.accepterId !== i.user.id) {
    return i.followUp({ content: "You're not the accepter.", ephemeral: true });
  }

  // Re-fetch with potentially-updated accepterId.
  const refreshed = await getBet(betId);
  if (!refreshed?.accepterId) {
    return i.followUp({
      content: "Internal error: bet still has no accepter.",
      ephemeral: true,
    });
  }

  // Ensure both participants have a wallet on the bet's chain. If not, DM
  // them a chain-tagged link.
  const chain = refreshed.chain as "solana" | "base";
  const chainLabel = chain === "solana" ? "Solana" : "Base";
  const walletOf = (u: { walletPubkey?: string | null; evmAddress?: string | null } | null) =>
    chain === "solana" ? u?.walletPubkey : u?.evmAddress;
  const challenger = await getUser(refreshed.challengerId);
  const accepter = await getUser(refreshed.accepterId);
  if (!walletOf(challenger ?? null)) {
    const { url } = await createWalletLinkSession(refreshed.challengerId);
    try {
      const u = await i.client.users.fetch(refreshed.challengerId);
      await u.send(`Link your ${chainLabel} wallet to fund your bet: ${url}?chain=${chain}`);
    } catch {}
  }
  if (!walletOf(accepter ?? null)) {
    const { url } = await createWalletLinkSession(refreshed.accepterId);
    try {
      await i.user.send(`Link your ${chainLabel} wallet to fund your bet: ${url}?chain=${chain}`);
    } catch {}
  }

  await acceptBet(betId, i.user.id);

  // If both wallets are linked on this chain, initialize + send fund links.
  const c2 = await getUser(refreshed.challengerId);
  const a2 = await getUser(refreshed.accepterId);
  if (walletOf(c2 ?? null) && walletOf(a2 ?? null)) {
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
  const recipients = bet.accepterId
    ? [bet.challengerId, bet.accepterId]
    : [bet.challengerId];
  for (const uid of recipients) {
    try {
      const u = await i.client.users.fetch(uid);
      await u.send(dmContent);
    } catch {}
  }
}

/** DM both participants when a bet resolves, with the verbatim terms repeated
 *  one final time so the resolution rationale is unambiguous. Third repetition
 *  in the outcome-contract chain.
 *
 *  The LOSER also gets a 🎲 Double-or-Nothing button: one-click fork into
 *  a rematch with doubled stake. Winner gets nothing extra (they already won).
 */
async function sendResolutionDms(
  i: ButtonInteraction | ChatInputCommandInteraction,
  betId: bigint,
) {
  const bet = await getBet(betId);
  if (!bet) return;
  const winner = bet.winnerId ? `<@${bet.winnerId}>` : "(unknown)";
  const txLink = bet.resolutionTxSig
    ? chainExplorerTxUrl(bet.chain as Chain, bet.resolutionTxSig)
    : null;
  const lines = [
    `**Bet \`${bet.shortcode}\` resolved.** Winner: ${winner}.`,
    "",
    "Terms:",
    `> ${bet.description}`,
  ];
  if (txLink) lines.push("", `On-chain: ${txLink}`);
  const dmContent = lines.join("\n");
  const recipients = bet.accepterId
    ? [bet.challengerId, bet.accepterId]
    : [bet.challengerId];
  // Loser gets the 🎲 Double or Nothing button. Winner gets a plain DM.
  const loserId =
    bet.winnerId && bet.accepterId
      ? bet.winnerId === bet.challengerId
        ? bet.accepterId
        : bet.challengerId
      : null;
  for (const uid of recipients) {
    try {
      const u = await i.client.users.fetch(uid);
      if (uid === loserId) {
        await u.send({
          content: dmContent,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`don:${bet.id}`)
                .setLabel("🎲 Double or Nothing")
                .setStyle(ButtonStyle.Primary),
            ),
          ],
        });
      } else {
        await u.send(dmContent);
      }
    } catch {}
  }
}

/** 🎲 Double-or-Nothing button on the loser's resolution DM. One click forks
 *  a rematch with doubled stake. */
export async function handleDoubleOrNothing(
  i: ButtonInteraction,
  betId: bigint,
) {
  await i.deferUpdate();
  const result = await createRematch({
    parentBetId: betId,
    initiatorId: i.user.id,
  });
  if (!result.ok) {
    await i.followUp({
      content: `Couldn't create rematch: ${result.reason}`,
      ephemeral: true,
    });
    return;
  }
  const parent = await getBet(betId);
  if (!parent) return;
  const newAmount = (Number(BigInt(parent.amount)) * 2) / 1e6;
  // Post the rematch announcement in the same channel the original was in.
  try {
    const ch = await i.client.channels.fetch(parent.channelId);
    if (ch?.isTextBased() && "send" in ch) {
      const card = renderBetCard({
        betId: result.betId,
        challenger: `<@${i.user.id}>`,
        accepter: `<@${parent.winnerId ?? parent.accepterId ?? "?"}>`,
        amount: newAmount,
        description: parent.description,
        canonical: result.termsCanonical !== parent.description ? result.termsCanonical : null,
        status: "proposed",
        shortcode: result.shortcode,
        settlementChain: result.chain,
        chainDepth: Number(parent.chainDepth ?? 0) + 1,
        parentShortcode: parent.shortcode,
      });
      const winnerId =
        parent.winnerId === parent.challengerId
          ? parent.accepterId
          : parent.challengerId;
      void winnerId;
      const msg = await ch.send({
        content: `🎲 **Double or Nothing!** <@${parent.winnerId}> — <@${i.user.id}> wants another shot for ${newAmount.toFixed(2)} mUSDC. Bet code: \`${result.shortcode}\` (rematch of \`${parent.shortcode}\`)`,
        embeds: [card.embed],
        components: [card.proposeRow(result.betId)],
      });
      await setAnnounceMessageId(result.betId, msg.id);
    }
  } catch (e) {
    console.warn("[DoN] failed to post rematch in channel:", String(e));
  }
  // Edit the original DM to remove the now-used button.
  try {
    await i.editReply({ components: [] });
  } catch {}
}

export async function handleDecline(i: ButtonInteraction, betId: bigint) {
  await i.deferUpdate();
  const bet = await getBet(betId);
  if (!bet) return;
  // Decline is only valid while the bet is still in 'proposed' state.
  // Open bets that have been claimed (accepterId set) AND any bet past
  // proposed are off-limits via this button.
  if (bet.status !== "proposed") {
    return i.followUp({
      content: `Bet is already ${bet.status} — too late to decline.`,
      ephemeral: true,
    });
  }
  // Open bets (still unclaimed): only the challenger can cancel.
  // Open bets that got claimed in a race: accepterId is now set, isOpen
  // remains true, but status is still proposed → fall through to the
  // 'targeted' rule (accepter declines).
  // Targeted bets: only the challenged user can decline.
  const isUnclaimedOpen = bet.isOpen && bet.accepterId === null;
  const allowed = isUnclaimedOpen
    ? bet.challengerId === i.user.id
    : bet.accepterId === i.user.id;
  if (!allowed) {
    return i.followUp({
      content: isUnclaimedOpen
        ? "Only the challenger can cancel an open bet."
        : "Only the challenged user can decline.",
      ephemeral: true,
    });
  }
  await declineBet(betId, i.user.id);
  await updateAnnouncement(i.client, betId);
}

