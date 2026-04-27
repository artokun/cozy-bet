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

/** commandName → handler. Exported so tests can assert every entry in
 *  commandDefinitions has a routing entry (else we'd ship a slash command
 *  that registered with Discord but did nothing). */
export const slashRoutes: Record<
  string,
  (i: ChatInputCommandInteraction) => Promise<unknown> | unknown
> = {
  saybet: handleSaybet,
  mybets: handleMyBets,
  "open-bets": handleOpenBets,
  resolve: handleResolve,
  draw: handleDraw,
  cancel: handleCancel,
  counter: handleCounter,
  linkwallet: handleLinkWallet,
  linktwitter: handleLinkTwitter,
  share: handleShare,
  "confirm-share": handleConfirmShare,
  balance: handleBalance,
  help: handleHelp,
  status: handleStatus,
  leaderboard: handleLeaderboard,
  adminresolve: handleAdminResolve,
  reconcile: handleReconcile,
  "preview-terms": handlePreviewTerms,
  requestarbiter: handleRequestArbiter,
  "arbiter-claim": handleArbiterClaim,
  "arbiter-review": handleArbiterReview,
  "arbiter-decide": handleArbiterDecide,
  "admin-stats": handleAdminStats,
};

/** action prefix → button handler. customId format is `action:betId[:arg]`. */
export const buttonRoutes: Record<
  string,
  (i: ButtonInteraction, betId: bigint) => Promise<unknown> | unknown
> = {
  accept: handleAccept,
  decline: handleDecline,
  don: handleDoubleOrNothing,
  "cancel-agree": handleCancelAgree,
  "cancel-deny": handleCancelDeny,
  "counter-agree": handleCounterAgree,
  "counter-deny": handleCounterDeny,
};

/** action prefix → select-menu handler. */
export const selectMenuRoutes: Record<
  string,
  (i: StringSelectMenuInteraction) => Promise<unknown> | unknown
> = {
  dunk: handleDunkSelect,
};

export async function routeSlash(i: ChatInputCommandInteraction) {
  const handler = slashRoutes[i.commandName];
  if (handler) return handler(i);
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
  const handler = buttonRoutes[action];
  if (handler) return handler(i, betId);
}

export async function routeSelectMenu(i: StringSelectMenuInteraction) {
  const [action] = i.customId.split(":");
  if (!action) return;
  const handler = selectMenuRoutes[action];
  if (handler) return handler(i);
}
