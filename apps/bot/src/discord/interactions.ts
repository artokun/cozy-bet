import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  handleAccept,
  handleAdminResolve,
  handleAdminStats,
  handleArbiterClaim,
  handleArbiterDecide,
  handleArbiterReview,
  handleBalance,
  handleCancel,
  handleConfirmShare,
  handleCancelAgree,
  handleCancelDeny,
  handleCounter,
  handleCounterAgree,
  handleCounterDeny,
  handleDecline,
  handleDoubleOrNothing,
  handleDraw,
  handleDunkSelect,
  handleHelp,
  handleLeaderboard,
  handleLinkTwitter,
  handleLinkWallet,
  handleMyBets,
  handleShare,
  handleOpenBets,
  handlePreviewTerms,
  handleReconcile,
  handleRequestArbiter,
  handleResolve,
  handleSaybet,
  handleStatus,
} from "./commands.js";

export async function routeSlash(i: ChatInputCommandInteraction) {
  switch (i.commandName) {
    case "saybet":
      return handleSaybet(i);
    case "mybets":
      return handleMyBets(i);
    case "open-bets":
      return handleOpenBets(i);
    case "resolve":
      return handleResolve(i);
    case "draw":
      return handleDraw(i);
    case "cancel":
      return handleCancel(i);
    case "counter":
      return handleCounter(i);
    case "linkwallet":
      return handleLinkWallet(i);
    case "linktwitter":
      return handleLinkTwitter(i);
    case "share":
      return handleShare(i);
    case "confirm-share":
      return handleConfirmShare(i);
    case "balance":
      return handleBalance(i);
    case "help":
      return handleHelp(i);
    case "status":
      return handleStatus(i);
    case "leaderboard":
      return handleLeaderboard(i);
    case "adminresolve":
      return handleAdminResolve(i);
    case "reconcile":
      return handleReconcile(i);
    case "preview-terms":
      return handlePreviewTerms(i);
    case "requestarbiter":
      return handleRequestArbiter(i);
    case "arbiter-claim":
      return handleArbiterClaim(i);
    case "arbiter-review":
      return handleArbiterReview(i);
    case "arbiter-decide":
      return handleArbiterDecide(i);
    case "admin-stats":
      return handleAdminStats(i);
  }
}

export async function routeButton(i: ButtonInteraction) {
  const [action, betIdStr] = i.customId.split(":");
  if (!action || !betIdStr) {
    await i.reply({ content: "Invalid button id.", ephemeral: true });
    return;
  }
  let betId: bigint;
  try {
    betId = BigInt(betIdStr);
  } catch {
    await i.reply({ content: "Invalid bet id.", ephemeral: true });
    return;
  }
  switch (action) {
    case "accept":
      return handleAccept(i, betId);
    case "decline":
      return handleDecline(i, betId);
    case "don":
      return handleDoubleOrNothing(i, betId);
    case "cancel-agree":
      return handleCancelAgree(i, betId);
    case "cancel-deny":
      return handleCancelDeny(i, betId);
    case "counter-agree":
      return handleCounterAgree(i, betId);
    case "counter-deny":
      return handleCounterDeny(i, betId);
  }
}

export async function routeSelectMenu(i: StringSelectMenuInteraction) {
  const [action] = i.customId.split(":");
  switch (action) {
    case "dunk":
      return handleDunkSelect(i);
  }
}
