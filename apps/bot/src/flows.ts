import { getDb, users, bets, betEvents, walletLinkSessions, allowlist } from "@cozy-bet/db";
import { BetStatus, makeShortcode, isShortcode } from "@cozy-bet/shared";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { env } from "./env.js";
import {
  type Chain,
  chainArbiterResolve,
  chainInitializeBet,
  chainResolve,
  chainDraw,
  chainRefund,
  chainFetchBet,
  chainSetFeeBpsForSide,
} from "./chain.js";
import { disambig, termsHashOf } from "./llm.js";
import { isOnTimeResolution } from "./reliability.js";

/** Determine the wallet a user has linked on a given chain. Returns null if
 *  they haven't linked one. */
function userWalletForChain(
  user: typeof users.$inferSelect | null,
  chain: Chain,
): string | null {
  if (!user) return null;
  return chain === "solana" ? user.walletPubkey : user.evmAddress;
}

function db() {
  return getDb(env.DATABASE_URL);
}

export async function upsertUser(discordId: string) {
  const d = db();
  await d.insert(users).values({ discordId }).onConflictDoNothing();
}

export async function isAllowed(discordId: string): Promise<boolean> {
  if (!env.USER_ALLOWLIST_ENABLED) return true;
  const d = db();
  const rows = await d.select().from(allowlist).where(eq(allowlist.discordId, discordId));
  return rows.length > 0;
}

export async function createWalletLinkSession(discordId: string) {
  const d = db();
  await upsertUser(discordId);
  const nonce = nanoid(24);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await d.insert(walletLinkSessions).values({ nonce, discordId, expiresAt });
  return { nonce, url: `${env.WEB_PUBLIC_URL}/link/${nonce}` };
}

export async function getUser(discordId: string) {
  const d = db();
  const rows = await d.select().from(users).where(eq(users.discordId, discordId));
  return rows[0] ?? null;
}

export async function setUserWallet(discordId: string, walletPubkey: string) {
  const d = db();
  // First chain linked becomes the user's preferred chain.
  const existing = await getUser(discordId);
  await d
    .update(users)
    .set({
      walletPubkey,
      linkedAt: new Date(),
      preferredChain: existing?.preferredChain ?? "solana",
    })
    .where(eq(users.discordId, discordId));
}

/** Save the user's self-attested X (Twitter) handle. No leading '@'. */
export async function setUserXHandle(discordId: string, xHandle: string) {
  const d = db();
  await upsertUser(discordId);
  await d
    .update(users)
    .set({ xHandle: xHandle.replace(/^@/, "") })
    .where(eq(users.discordId, discordId));
}

/** Apply a verified /share discount: record the tweet URL on the bet for the
 *  caller's side AND call setFeeBpsForSide on-chain to drop their fee bps to
 *  the configured discount (default 150). Idempotent — re-running returns the
 *  existing url without re-firing the on-chain call. */
export async function applyShareDiscount(args: {
  betId: bigint;
  participantId: string;
  participantWallet: string;
  tweetUrl: string;
  newBps: number;
}) {
  const d = db();
  const bet = await getBet(args.betId);
  if (!bet) throw new Error("bet not found");
  if (
    args.participantId !== bet.challengerId &&
    args.participantId !== bet.accepterId
  ) {
    throw new Error("not a participant");
  }
  const isChallenger = args.participantId === bet.challengerId;
  const existing = isChallenger
    ? bet.challengerShareUrl
    : bet.accepterShareUrl;
  if (existing) {
    // Existing PENDING:* means a sibling /confirm-share is mid-flight —
    // surface that as a retry-shortly hint, not as "you already redeemed"
    // (the partial redeem might still roll back if its on-chain call
    // throws and the catch path clears the slot).
    if (existing.startsWith("PENDING:")) {
      throw new Error(
        "another /confirm-share for this bet is in flight — retry in a few seconds",
      );
    }
    return { alreadyApplied: true as const, url: existing };
  }
  // Discounts only make sense before the bet pays out — after Resolved/Drawn
  // the fee bps are already baked into the resolve tx. Pre-Funded is fine
  // (the bps is read at resolve time, not deposit time).
  if (
    bet.status !== BetStatus.Proposed &&
    bet.status !== BetStatus.Accepted &&
    bet.status !== BetStatus.Pending &&
    bet.status !== BetStatus.Funded
  ) {
    throw new Error(
      `bet is ${bet.status} — discount can only be applied before resolve`,
    );
  }
  // Atomically claim the per-side share slot via a conditional UPDATE.
  // Two concurrent /confirm-share calls (double-tap, retry) both pass the
  // pre-check above, but only one wins this UPDATE — the other gets zero
  // affected rows and aborts before the on-chain setFeeBpsForSide fires.
  // Use a sentinel ("PENDING:<nonce>") rather than the final URL so we
  // don't leak the URL until the on-chain call confirms.
  // Sentinel embeds Date.now() so the stale-lock watchdog can detect
  // a stuck lock by age (mirrors claimResolutionLock).
  const pendingSentinel = `PENDING:${args.tweetUrl}:${Date.now()}`;
  const claimedRows = await d
    .update(bets)
    .set(
      isChallenger
        ? { challengerShareUrl: pendingSentinel }
        : { accepterShareUrl: pendingSentinel },
    )
    .where(
      and(
        eq(bets.id, args.betId),
        isNull(
          isChallenger ? bets.challengerShareUrl : bets.accepterShareUrl,
        ),
      ),
    )
    .returning();
  if (claimedRows.length === 0) {
    // Race lost OR slot already redeemed — refetch. A PENDING:* value
    // here means a sibling call is still in flight; surface the same
    // "retry shortly" hint as the entry-time check.
    const after = await getBet(args.betId);
    const url = isChallenger
      ? after?.challengerShareUrl
      : after?.accepterShareUrl;
    if (url?.startsWith("PENDING:")) {
      throw new Error(
        "another /confirm-share for this bet is in flight — retry in a few seconds",
      );
    }
    return {
      alreadyApplied: true as const,
      url: url ?? "(redeemed by a concurrent request)",
    };
  }
  let sig: string;
  try {
    sig = await chainSetFeeBpsForSide(bet.chain as Chain, {
      betId: args.betId,
      side: args.participantWallet,
      newBps: args.newBps,
    });
  } catch (e) {
    // On-chain call failed — release the slot so the user can retry.
    await d
      .update(bets)
      .set(
        isChallenger
          ? { challengerShareUrl: null }
          : { accepterShareUrl: null },
      )
      .where(eq(bets.id, args.betId));
    throw e;
  }
  // Replace the sentinel with the real URL now that the on-chain call
  // confirmed.
  await d
    .update(bets)
    .set(
      isChallenger
        ? { challengerShareUrl: args.tweetUrl }
        : { accepterShareUrl: args.tweetUrl },
    )
    .where(eq(bets.id, args.betId));
  await d.insert(betEvents).values({
    betId: args.betId,
    actorDiscordId: args.participantId,
    eventType: "share_verified",
    payload: { url: args.tweetUrl, side: isChallenger ? "challenger" : "accepter", newBps: args.newBps, sig },
  });
  return { alreadyApplied: false as const, url: args.tweetUrl, sig };
}

/** Link an EVM address to a discord user. Mirrors setUserWallet for Base. */
export async function setUserEvmAddress(discordId: string, evmAddress: string) {
  const d = db();
  const existing = await getUser(discordId);
  await d
    .update(users)
    .set({
      evmAddress,
      linkedAt: new Date(),
      preferredChain: existing?.preferredChain ?? "base",
    })
    .where(eq(users.discordId, discordId));
}

export async function proposeBet(args: {
  guildId: string;
  channelId: string;
  challengerId: string;
  /** null = open bet (anyone in channel can claim). */
  accepterId: string | null;
  amount: bigint;
  description: string;
  tokenMint: string;
  /** Settlement chain — locks at creation. Defaults to challenger's
   *  preferred_chain, falling back to "solana". */
  chain?: Chain;
  /** Optional deadline timestamp; default = now + 7d. */
  deadline?: Date;
  /** Tags for disambig context (challenger / accepter usernames). Optional. */
  challengerTag?: string;
  accepterTag?: string;
  /** Set when this is a Double-or-Nothing rematch. */
  parentBetId?: bigint;
  chainDepth?: number;
}): Promise<
  | { ok: true; betId: bigint; shortcode: string; termsCanonical: string; chain: Chain }
  | { ok: false; reason: "unresolvable" | "no_wallet"; detail: string }
> {
  await upsertUser(args.challengerId);
  if (args.accepterId) await upsertUser(args.accepterId);

  // Resolve the settlement chain. Explicit arg wins; otherwise fall back to
  // the challenger's preferred_chain; then "solana" for legacy users.
  const challengerUser = await getUser(args.challengerId);
  const chain: Chain =
    args.chain ?? (challengerUser?.preferredChain as Chain | null) ?? "solana";

  // Challenger must have a wallet on the chosen chain — otherwise the bet
  // would be unfundable. We don't gate the accepter (they can link
  // post-Accept) but they'll hit the same check at initialize_bet time.
  if (!userWalletForChain(challengerUser, chain)) {
    const which = chain === "solana" ? "Solana" : "Base";
    return {
      ok: false,
      reason: "no_wallet",
      detail: `link your ${which} wallet first with /linkwallet (chain: ${chain})`,
    };
  }

  // Run disambig before creating the bet. If LLM rejects as unresolvable,
  // refuse to create the bet — better to make the user reword than lock
  // funds in a contract bound to ambiguous terms.
  const disambigResult = await disambig({
    userPhrase: args.description,
    challengerTag: args.challengerTag ?? args.challengerId,
    accepterTag: args.accepterTag ?? args.accepterId ?? "any taker",
    todayIso: new Date().toISOString().slice(0, 10),
  });
  if (disambigResult.kind === "unresolvable") {
    return { ok: false, reason: "unresolvable", detail: disambigResult.reason };
  }
  const termsCanonical = disambigResult.canonical;

  const betId = BigInt(Date.now()) * 4096n + BigInt(Math.floor(Math.random() * 4096));
  const deadline = args.deadline ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const d = db();

  // Insert with retry on shortcode collision
  let shortcode = makeShortcode();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await d.insert(bets).values({
        id: betId,
        guildId: args.guildId,
        channelId: args.channelId,
        challengerId: args.challengerId,
        accepterId: args.accepterId,
        isOpen: args.accepterId === null,
        amount: args.amount,
        tokenMint: args.tokenMint,
        description: args.description,
        termsCanonical,
        shortcode,
        status: BetStatus.Proposed,
        chain,
        deadline,
        parentBetId: args.parentBetId ?? null,
        chainDepth: args.chainDepth ?? 0,
      });
      break;
    } catch (e: any) {
      if (
        e?.code === "23505" &&
        String(e?.constraint_name ?? "").includes("shortcode")
      ) {
        shortcode = makeShortcode();
        continue;
      }
      throw e;
    }
  }
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: args.challengerId,
    eventType: "proposed",
    payload: {
      amount: args.amount.toString(),
      description: args.description,
      termsCanonical,
      disambigKind: disambigResult.kind,
      shortcode,
      deadline: deadline.toISOString(),
      chain,
    },
  });
  return { ok: true, betId, shortcode, termsCanonical, chain };
}

/** Lookup helper. Accepts either a full numeric bet_id or a shortcode. */
export async function findBetByIdOrShortcode(input: string) {
  const d = db();
  if (isShortcode(input)) {
    const rows = await d
      .select()
      .from(bets)
      .where(eq(bets.shortcode, input.toUpperCase()))
      .limit(1);
    return rows[0] ?? null;
  }
  try {
    const id = BigInt(input);
    const rows = await d.select().from(bets).where(eq(bets.id, id)).limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getBet(betId: bigint) {
  const d = db();
  const rows = await d.select().from(bets).where(eq(bets.id, betId));
  return rows[0] ?? null;
}

export async function setAnnounceMessageId(betId: bigint, messageId: string) {
  const d = db();
  await d
    .update(bets)
    .set({ announceMessageId: messageId })
    .where(eq(bets.id, betId));
}

/**
 * Atomic claim of an open bet. Sets accepter_id only if NULL (so only one
 * concurrent claimer wins). Self-claim by challenger is rejected.
 *
 * Returns the bet on success; null if already claimed (race lost).
 */
/**
 * Fork a Double-or-Nothing rematch from a resolved bet. Loser becomes the new
 * challenger, winner is the new accepter, stake doubles, parent_bet_id +
 * chain_depth track lineage.
 */
export async function createRematch(args: {
  parentBetId: bigint;
  initiatorId: string; // must be the original loser
}): Promise<
  | { ok: true; betId: bigint; shortcode: string; termsCanonical: string; chain: Chain }
  | { ok: false; reason: string }
> {
  const parent = await getBet(args.parentBetId);
  if (!parent) return { ok: false, reason: "parent bet not found" };
  if (parent.status !== BetStatus.Resolved) {
    return { ok: false, reason: "parent bet is not resolved" };
  }
  if (!parent.winnerId || !parent.accepterId) {
    return { ok: false, reason: "parent bet has no winner / accepter" };
  }
  const loserId =
    parent.winnerId === parent.challengerId
      ? parent.accepterId
      : parent.challengerId;
  if (args.initiatorId !== loserId) {
    return { ok: false, reason: "only the loser can request a rematch" };
  }
  const newAmount = BigInt(parent.amount) * 2n;

  const result = await proposeBet({
    guildId: parent.guildId,
    channelId: parent.channelId,
    challengerId: loserId,
    accepterId: parent.winnerId,
    amount: newAmount,
    description: parent.description,
    tokenMint: parent.tokenMint,
    chain: parent.chain as Chain,
    parentBetId: parent.id,
    chainDepth: Number(parent.chainDepth ?? 0) + 1,
  });
  if (!result.ok) return { ok: false, reason: result.detail };
  return result;
}

export async function claimOpenBet(
  betId: bigint,
  claimantId: string,
): Promise<typeof bets.$inferSelect | null> {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.isOpen) throw new Error("not an open bet");
  if (bet.status !== BetStatus.Proposed) throw new Error(`bet is ${bet.status}`);
  if (bet.challengerId === claimantId) {
    throw new Error("you can't accept your own challenge");
  }
  await upsertUser(claimantId);

  // Atomic: SET accepter_id = X WHERE id = Y AND accepter_id IS NULL
  // postgres-js returns affected rows in `count` field on UPDATE.
  const updated = await d
    .update(bets)
    .set({ accepterId: claimantId })
    .where(and(eq(bets.id, betId), isNull(bets.accepterId)))
    .returning();
  if (updated.length === 0) {
    return null; // someone else got there first
  }
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: claimantId,
    eventType: "open_claimed",
  });
  return updated[0]!;
}

export async function acceptBet(betId: bigint, acceptorId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (bet.accepterId !== acceptorId) throw new Error("not the accepter");
  if (bet.status !== BetStatus.Proposed) throw new Error(`bet is ${bet.status}`);
  await d
    .update(bets)
    .set({ status: BetStatus.Accepted })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: acceptorId,
    eventType: "accepted",
  });
  return bet;
}

export async function declineBet(betId: bigint, declinerId: string) {
  const d = db();
  await d
    .update(bets)
    .set({ status: BetStatus.Canceled })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: declinerId,
    eventType: "declined",
  });
}

/** Call initialize_bet on-chain once both users accepted + linked their wallets. */
export async function initializeOnChain(betId: bigint) {
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (bet.status !== BetStatus.Accepted) throw new Error(`bet is ${bet.status}`);
  if (!bet.accepterId) throw new Error("bet has no accepter yet");
  const chain = bet.chain as Chain;
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  const challengerWallet = userWalletForChain(challenger, chain);
  const accepterWallet = userWalletForChain(accepter, chain);
  if (!challengerWallet || !accepterWallet) {
    throw new Error(`both users must link their ${chain} wallets first`);
  }
  // Compute the terms hash from the canonical sentence so the on-chain bet
  // is cryptographically bound to the agreed terms. Falls back to all-zeros
  // for legacy bets that predate the canonical column.
  const termsHash = bet.termsCanonical
    ? Array.from(termsHashOf(bet.termsCanonical))
    : null;
  const d = db();
  // Atomic init lock: two concurrent Accept clicks (button double-tap)
  // would otherwise both reach chainInitializeBet. The Anchor program +
  // Solidity contract reject the duplicate via PDA / seed collision, but
  // the second tx still burns gas + leaves a confusing on-chain log.
  // Same pattern as claimResolutionLock; uses init_tx_sig as the slot.
  const claimed = await d
    .update(bets)
    .set({ initTxSig: `PENDING:initialize:${Date.now()}` })
    .where(and(eq(bets.id, betId), isNull(bets.initTxSig)))
    .returning();
  if (claimed.length === 0) {
    throw new Error(
      "another initialize is already in flight for this bet (race lost)",
    );
  }
  let sig: string, betPda: string | undefined, vaultPda: string | undefined;
  try {
    ({ sig, betPda, vaultPda } = await chainInitializeBet(chain, {
      betId,
      amount: BigInt(bet.amount),
      challenger: challengerWallet,
      accepter: accepterWallet,
      termsHash,
    }));
  } catch (e) {
    // Release the lock so the user can retry after fixing whatever
    // (e.g. wallet linking, RPC outage).
    await d
      .update(bets)
      .set({ initTxSig: null })
      .where(eq(bets.id, betId));
    throw e;
  }
  await d
    .update(bets)
    .set({
      status: BetStatus.Pending,
      betPda: betPda ?? null,
      vaultPda: vaultPda ?? null,
      initTxSig: sig,
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "initialized",
    payload: { sig, betPda: betPda ?? null, chain },
  });
  return { sig, betPda, vaultPda };
}

/** Web UI calls this after the user's deposit tx confirms. The bot does NOT
 *  trust the web callback — it reads the on-chain Bet account to decide
 *  whether the deposit actually landed. This prevents a malicious caller from
 *  marking the other party as deposited without them having sent tokens. */
export async function recordDeposit(
  betId: bigint,
  depositorWallet: string,
  txSig: string,
) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");

  const onChain = await chainFetchBet(bet.chain as Chain, betId);
  if (!onChain) throw new Error("on-chain bet not found");

  const patch: Partial<typeof bets.$inferInsert> = {
    challengerDeposited: onChain.challengerDeposited,
    accepterDeposited: onChain.accepterDeposited,
  };
  const wasNotFunded = bet.status !== BetStatus.Funded;
  const isNowFunded = onChain.status === "funded";
  if (wasNotFunded && isNowFunded) {
    patch.status = BetStatus.Funded;
    patch.fundedAt = new Date();
  }
  await d.update(bets).set(patch).where(eq(bets.id, betId));

  // Attribute the event to whichever side just transitioned to deposited
  // (by comparing old DB state to new on-chain state), if determinable.
  const actorId =
    !bet.challengerDeposited && onChain.challengerDeposited
      ? bet.challengerId
      : !bet.accepterDeposited && onChain.accepterDeposited
        ? bet.accepterId
        : null;

  await d.insert(betEvents).values({
    betId,
    actorDiscordId: actorId,
    eventType: "deposited",
    payload: {
      sig: txSig,
      reportedDepositor: depositorWallet,
      onChainChallengerDep: onChain.challengerDeposited,
      onChainAccepterDep: onChain.accepterDeposited,
    },
  });

  return { fullyFunded: Boolean(patch.status === BetStatus.Funded) };
}

/** Reconcile DB state with on-chain state. Useful for recovering from missed
 *  web callbacks or manual inspection. */
export async function reconcileBet(betId: bigint) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  const onChain = await chainFetchBet(bet.chain as Chain, betId);
  if (!onChain) return { changed: false, reason: "no on-chain state yet" };

  const patch: Partial<typeof bets.$inferInsert> = {};
  if (bet.challengerDeposited !== onChain.challengerDeposited) {
    patch.challengerDeposited = onChain.challengerDeposited;
  }
  if (bet.accepterDeposited !== onChain.accepterDeposited) {
    patch.accepterDeposited = onChain.accepterDeposited;
  }
  // Map on-chain status to DB enum
  const onChainStatus =
    onChain.status === "pending"
      ? BetStatus.Pending
      : onChain.status === "funded"
        ? BetStatus.Funded
        : onChain.status === "resolved"
          ? BetStatus.Resolved
          : onChain.status === "drawn"
            ? BetStatus.Drawn
            : onChain.status === "refunded"
              ? BetStatus.Refunded
              : null;
  if (
    onChainStatus &&
    bet.status !== onChainStatus &&
    // Only upgrade status forward; never demote
    ["proposed", "accepted", "pending", "funded"].includes(bet.status)
  ) {
    patch.status = onChainStatus;
    if (onChainStatus === BetStatus.Funded && !bet.fundedAt) {
      patch.fundedAt = new Date();
    }
    if (
      (onChainStatus === BetStatus.Resolved ||
        onChainStatus === BetStatus.Refunded ||
        onChainStatus === BetStatus.Drawn) &&
      !bet.resolvedAt
    ) {
      patch.resolvedAt = new Date();
    }
  }

  if (Object.keys(patch).length === 0) return { changed: false };
  await d.update(bets).set(patch).where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "reconciled",
    payload: { patch: JSON.parse(JSON.stringify(patch)) },
  });
  return { changed: true, patch };
}

/** Record a winner claim; if both sides claim the same winner, triggers resolve. */
export async function claimWinner(
  betId: bigint,
  actorId: string,
  claimedWinnerId: string,
) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (bet.status !== BetStatus.Funded) {
    throw new Error(`bet is ${bet.status}, cannot claim winner`);
  }
  if (actorId !== bet.challengerId && actorId !== bet.accepterId) {
    throw new Error("not a participant");
  }
  if (
    claimedWinnerId !== bet.challengerId &&
    claimedWinnerId !== bet.accepterId
  ) {
    throw new Error("winner must be a participant");
  }

  const patch: Partial<typeof bets.$inferInsert> = {};
  if (actorId === bet.challengerId) patch.challengerClaimsWinner = claimedWinnerId;
  else patch.accepterClaimsWinner = claimedWinnerId;

  await d.update(bets).set(patch).where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: actorId,
    eventType: "claim_win",
    payload: { claimed: claimedWinnerId },
  });

  const refreshed = await getBet(betId);
  if (!refreshed) throw new Error("bet disappeared");
  const c = refreshed.challengerClaimsWinner;
  const a = refreshed.accepterClaimsWinner;
  if (c && a) {
    if (c === a) {
      return await finalizeResolve(betId, c);
    } else {
      await d
        .update(bets)
        .set({ status: BetStatus.Disputed })
        .where(eq(bets.id, betId));
      await d.insert(betEvents).values({
        betId,
        eventType: "disputed",
        payload: { challenger: c, accepter: a },
      });
      return { outcome: "disputed" as const };
    }
  }
  return { outcome: "pending" as const };
}

/** Either party claims a draw. When both have claimed, calls draw() on-chain. */
export async function claimDraw(betId: bigint, actorId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (bet.status !== BetStatus.Funded) {
    throw new Error(`bet is ${bet.status}, cannot claim draw`);
  }
  if (actorId !== bet.challengerId && actorId !== bet.accepterId) {
    throw new Error("not a participant");
  }
  // A side that already claimed a winner can't simultaneously claim draw —
  // they need to /resolve again with the same winner as the other side, or
  // walk it back. Simpler: if either side has a winner claim recorded,
  // claim_draw is rejected unless the side claiming draw has no winner claim.
  // For now we just ALLOW switching from winner-claim to draw-claim; the
  // 'resolve when both agree' check is independent.
  const patch: Partial<typeof bets.$inferInsert> = {};
  if (actorId === bet.challengerId) patch.challengerClaimsDraw = true;
  else patch.accepterClaimsDraw = true;

  await d.update(bets).set(patch).where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: actorId,
    eventType: "claim_draw",
  });

  const refreshed = await getBet(betId);
  if (!refreshed) throw new Error("bet disappeared");
  if (refreshed.challengerClaimsDraw && refreshed.accepterClaimsDraw) {
    return await finalizeDraw(betId);
  }
  return { outcome: "pending" as const };
}

/**
 * Atomic "claim the resolution slot" — only one caller can transition
 * a bet from "no resolution" to "resolution-in-flight" via this gate.
 * Subsequent callers see zero affected rows and throw.
 *
 * The lock value is `PENDING:<reason>` written into resolution_tx_sig.
 * Once the on-chain call returns the real sig, callers overwrite it
 * with the tx hash. On failure, callers reset to NULL via
 * releaseResolutionLock so the user can retry.
 *
 * Used to protect concurrent finalizeResolve / finalizeDraw /
 * arbiterDecide / refundBet races where both calls would otherwise
 * fire the irreversible chain* call independently.
 */
async function claimResolutionLock(betId: bigint, reason: string) {
  const d = db();
  // Sentinel format: `PENDING:<reason>:<unix-ms>`. The trailing
  // timestamp lets the stale-lock watchdog tick distinguish a
  // just-acquired lock from one stuck for >5 minutes (the bot crashed
  // mid-chain-call). Without the timestamp we'd have to gate on
  // bet.createdAt — which is the wrong column entirely (bet may be
  // weeks old, lock just acquired).
  const value = `PENDING:${reason}:${Date.now()}`;
  const claimed = await d
    .update(bets)
    .set({ resolutionTxSig: value })
    .where(and(eq(bets.id, betId), isNull(bets.resolutionTxSig)))
    .returning();
  if (claimed.length === 0) {
    throw new Error(
      "another resolution is already in flight for this bet (race lost)",
    );
  }
}

async function releaseResolutionLock(betId: bigint) {
  const d = db();
  await d
    .update(bets)
    .set({ resolutionTxSig: null })
    .where(eq(bets.id, betId));
}

async function finalizeDraw(betId: bigint) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.accepterId) throw new Error("bet has no accepter");
  const chain = bet.chain as Chain;
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  const challengerWallet = userWalletForChain(challenger, chain);
  const accepterWallet = userWalletForChain(accepter, chain);
  if (!challengerWallet || !accepterWallet) {
    throw new Error("participant wallets missing");
  }
  await claimResolutionLock(betId, "draw");
  let sig: string;
  try {
    sig = await chainDraw(chain, {
      betId,
      challenger: challengerWallet,
      accepter: accepterWallet,
    });
  } catch (e) {
    await releaseResolutionLock(betId);
    throw e;
  }
  await d
    .update(bets)
    .set({
      status: BetStatus.Drawn,
      resolutionTxSig: sig,
      resolvedAt: new Date(),
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "drawn",
    payload: { sig },
  });
  // Reliability counters are a leaderboard side-effect; failure here
  // shouldn't mask a successful on-chain resolve. Log + continue.
  try {
    await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  } catch (e) {
    console.warn(
      `[bumpReliability] failed for bet ${bet.id} — leaderboard counters skipped:`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return { outcome: "drawn" as const, sig };
}

async function finalizeResolve(betId: bigint, winnerDiscordId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  const chain = bet.chain as Chain;
  const winner = await getUser(winnerDiscordId);
  const winnerWallet = userWalletForChain(winner, chain);
  if (!winnerWallet) {
    throw new Error(`winner has no linked ${chain} wallet`);
  }

  await claimResolutionLock(betId, "resolve");
  let sig: string;
  try {
    sig = await chainResolve(chain, {
      betId,
      winner: winnerWallet,
    });
  } catch (e) {
    await releaseResolutionLock(betId);
    throw e;
  }
  await d
    .update(bets)
    .set({
      status: BetStatus.Resolved,
      winnerId: winnerDiscordId,
      resolutionTxSig: sig,
      resolvedAt: new Date(),
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "resolved",
    payload: { sig, winner: winnerDiscordId },
  });
  // Reliability counters are a leaderboard side-effect; failure here
  // shouldn't mask a successful on-chain resolve. Log + continue.
  try {
    await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  } catch (e) {
    console.warn(
      `[bumpReliability] failed for bet ${bet.id} — leaderboard counters skipped:`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return { outcome: "resolved" as const, sig, winnerDiscordId };
}

/** Increment resolve_events for both participants. Increment resolve_score_good
 *  only if resolved within 24h of the deadline (or 24h of now if deadline
 *  isn't set). Called on every completed bet (resolved/drawn/refunded).
 *  accepterId may be null on bets that were canceled while still open. */
async function bumpReliability(
  challengerId: string,
  accepterId: string | null,
  deadline: Date | null,
) {
  const d = db();
  const now = new Date();
  const within24h = isOnTimeResolution(now, deadline);
  const recipients = accepterId ? [challengerId, accepterId] : [challengerId];
  for (const uid of recipients) {
    if (within24h) {
      await d.execute(
        sql`UPDATE users SET resolve_events = resolve_events + 1, resolve_score_good = resolve_score_good + 1 WHERE discord_id = ${uid}`,
      );
    } else {
      await d.execute(
        sql`UPDATE users SET resolve_events = resolve_events + 1 WHERE discord_id = ${uid}`,
      );
    }
  }
}

/** Returns "92% confirm rate (24 bets)" or null if user has no events yet. */
export async function reliabilityLabel(discordId: string): Promise<string | null> {
  const u = await getUser(discordId);
  if (!u) return null;
  const events = Number(u.resolveEvents ?? 0);
  if (events < 1) return null;
  const good = Number(u.resolveScoreGood ?? 0);
  const pct = Math.round((good / events) * 100);
  return `✋ ${pct}% confirm rate (${events} bet${events === 1 ? "" : "s"})`;
}

/** Admin can force-resolve a disputed bet. Bypasses mutual consent. */
export async function adminResolve(
  betId: bigint,
  adminDiscordId: string,
  winnerDiscordId: string,
) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (bet.status !== BetStatus.Disputed && bet.status !== BetStatus.Funded) {
    throw new Error(`bet status is ${bet.status}, can only override when disputed or funded`);
  }
  if (winnerDiscordId !== bet.challengerId && winnerDiscordId !== bet.accepterId) {
    throw new Error("winner must be a participant");
  }
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: adminDiscordId,
    eventType: "admin_override",
    payload: { winner: winnerDiscordId },
  });
  return await finalizeResolve(betId, winnerDiscordId);
}

/**
 * Single-round counter-proposal. Either participant can call this while the
 * bet is still in 'proposed' state to amend the amount + description; the
 * counterparty gets Agree/Deny. On Agree, the bet's amount/description (and
 * canonical, if LLM is on) update; on Deny, terms stay as they were.
 *
 * Multi-round counter-back can be done by the receiver calling /counter
 * again with their own changes.
 */
export async function proposeCounter(args: {
  betId: bigint;
  requesterId: string;
  newAmount: bigint | null;
  newDescription: string | null;
}) {
  const d = db();
  const bet = await getBet(args.betId);
  if (!bet) throw new Error("bet not found");
  if (bet.status !== BetStatus.Proposed) {
    throw new Error(
      `bet is ${bet.status} — counter only works before either side accepts`,
    );
  }
  // Open bets without a claimer can't be countered (no counterparty to agree).
  if (bet.accepterId === null) {
    throw new Error(
      "open bet has no counterparty yet — wait for someone to claim, then /counter",
    );
  }
  if (
    args.requesterId !== bet.challengerId &&
    args.requesterId !== bet.accepterId
  ) {
    throw new Error("not a participant");
  }
  if (bet.counterAt) {
    throw new Error("a counter proposal is already open — agree or deny first");
  }
  if (args.newAmount === null && args.newDescription === null) {
    throw new Error("nothing to counter (provide amount or description)");
  }
  if (args.newAmount !== null && args.newAmount <= 0n) {
    throw new Error("amount must be positive");
  }
  await d
    .update(bets)
    .set({
      counterAmount: args.newAmount,
      counterDescription: args.newDescription,
      counterBy: args.requesterId,
      counterAt: new Date(),
    })
    .where(eq(bets.id, args.betId));
  await d.insert(betEvents).values({
    betId: args.betId,
    actorDiscordId: args.requesterId,
    eventType: "counter_proposed",
    payload: {
      newAmount: args.newAmount?.toString() ?? null,
      newDescription: args.newDescription,
    },
  });
  return await getBet(args.betId);
}

export async function agreeCounter(betId: bigint, agreerId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.counterAt || !bet.counterBy) {
    throw new Error("no counter proposal open");
  }
  if (agreerId === bet.counterBy) {
    throw new Error("requester cannot self-agree");
  }
  if (
    agreerId !== bet.challengerId &&
    agreerId !== bet.accepterId
  ) {
    throw new Error("not a participant");
  }
  if (bet.status !== BetStatus.Proposed) {
    throw new Error(`bet is ${bet.status} — counter no longer applicable`);
  }
  // Apply the counter. If description changed, re-disambig FIRST so we
  // don't end up with description != canonical (which would let the
  // on-chain terms_hash diverge from what users see).
  const patch: Partial<typeof bets.$inferInsert> = {
    counterAmount: null,
    counterDescription: null,
    counterBy: null,
    counterAt: null,
  };
  if (bet.counterAmount !== null) patch.amount = bet.counterAmount;
  if (bet.counterDescription !== null) {
    const r = await disambig({
      userPhrase: bet.counterDescription,
      challengerTag: bet.challengerId,
      accepterTag: bet.accepterId ?? "any taker",
      todayIso: new Date().toISOString().slice(0, 10),
    });
    if (r.kind === "unresolvable") {
      // Disambig failed → abort the counter agreement entirely. Clear the
      // counter markers (we don't want a stuck pending) but keep original
      // terms intact.
      await d
        .update(bets)
        .set({
          counterAmount: null,
          counterDescription: null,
          counterBy: null,
          counterAt: null,
        })
        .where(eq(bets.id, betId));
      throw new Error(
        `counter description is too ambiguous to lock in: ${r.reason}. Counter cleared; the original terms stand.`,
      );
    }
    patch.description = bet.counterDescription;
    patch.termsCanonical = r.canonical;
  }
  // TOCTOU guard: only apply if status is STILL proposed AND the counter we
  // just looked up is still the open one. This prevents a race with the
  // Accept button: if the accepter clicked Accept while we awaited disambig,
  // status will have changed and the conditional UPDATE will affect zero
  // rows. We treat that as "the bet was accepted before our agree completed
  // — counter is moot" and surface a clear error.
  const updated = await d
    .update(bets)
    .set(patch)
    .where(
      and(
        eq(bets.id, betId),
        eq(bets.status, BetStatus.Proposed),
        eq(bets.counterBy, bet.counterBy),
      ),
    )
    .returning();
  if (updated.length === 0) {
    throw new Error(
      "bet state changed while applying counter — likely accepted in parallel. The counter is no longer applicable.",
    );
  }
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: agreerId,
    eventType: "counter_agreed",
  });
  return await getBet(betId);
}

export async function denyCounter(betId: bigint, denierId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.counterAt || !bet.counterBy) {
    throw new Error("no counter proposal open");
  }
  if (denierId === bet.counterBy) {
    throw new Error("requester cannot self-deny");
  }
  // Mirror agreeCounter's participant gate: only the OTHER participant can
  // deny. This matters when the deny button got posted in the bet's
  // channel (DM-fallback path) where any reader could click it.
  if (denierId !== bet.challengerId && denierId !== bet.accepterId) {
    throw new Error("not a participant");
  }
  await d
    .update(bets)
    .set({
      counterAmount: null,
      counterDescription: null,
      counterBy: null,
      counterAt: null,
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: denierId,
    eventType: "counter_denied",
  });
}

/**
 * Either participant requests cancel. The counterparty has 24h to Agree
 * or Deny. Returns the bet with cancel_requested_* set.
 */
export async function requestCancel(betId: bigint, requesterId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (
    bet.status !== BetStatus.Pending &&
    bet.status !== BetStatus.Funded &&
    bet.status !== BetStatus.Disputed
  ) {
    throw new Error(`bet is ${bet.status}, cannot request cancel`);
  }
  if (
    requesterId !== bet.challengerId &&
    requesterId !== bet.accepterId
  ) {
    throw new Error("not a participant");
  }
  if (bet.cancelRequestedAt) {
    throw new Error("a cancel request is already open");
  }
  await d
    .update(bets)
    .set({ cancelRequestedAt: new Date(), cancelRequestedBy: requesterId })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: requesterId,
    eventType: "cancel_request",
  });
  return await getBet(betId);
}

/**
 * Counterparty accepts the cancel request → refund fires.
 */
export async function agreeCancel(betId: bigint, agreerId: string) {
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.cancelRequestedAt || !bet.cancelRequestedBy) {
    throw new Error("no cancel request open");
  }
  if (agreerId === bet.cancelRequestedBy) {
    throw new Error("requester cannot self-agree");
  }
  if (
    agreerId !== bet.challengerId &&
    agreerId !== bet.accepterId
  ) {
    throw new Error("not a participant");
  }
  // Clear the request markers BEFORE the refund so a partial-failure
  // recovery doesn't leave both states set.
  const d = db();
  await d
    .update(bets)
    .set({ cancelRequestedAt: null, cancelRequestedBy: null })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: agreerId,
    eventType: "cancel_agree",
  });
  const sig = await refundBet(betId);
  return { sig };
}

/** List unclaimed open bets in a guild, newest first. Used by /open-bets to
 *  surface bets that don't have a specified accepter yet so they don't have
 *  to be discovered via channel scrollback. */
export async function listOpenBetsForGuild(
  guildId: string,
  limit = 10,
) {
  const d = db();
  const rows = await d
    .select()
    .from(bets)
    .where(
      and(
        eq(bets.guildId, guildId),
        eq(bets.isOpen, true),
        isNull(bets.accepterId),
        eq(bets.status, BetStatus.Proposed),
      ),
    )
    .orderBy(sql`${bets.createdAt} DESC`)
    .limit(limit);
  return rows;
}

/** Winner chooses a dunk GIF post-resolution. Records URL + posted-at on the
 *  bet so we don't re-post and can show it in the explorer. Returns the
 *  loser's discord id so the caller can render the channel embed. */
export async function setDunkGif(args: {
  betId: bigint;
  winnerId: string;
  url: string;
}) {
  const d = db();
  const bet = await getBet(args.betId);
  if (!bet) throw new Error("bet not found");
  if (bet.winnerId !== args.winnerId) {
    throw new Error("only the winner can pick a dunk GIF");
  }
  const loserId =
    bet.winnerId && bet.accepterId
      ? bet.winnerId === bet.challengerId
        ? bet.accepterId
        : bet.challengerId
      : null;
  // Atomic claim: two concurrent SelectMenu submissions from the winner
  // (e.g. fast double-tap, gateway retry) would otherwise both pass the
  // dunkPostedAt check and both fire safeChannelSend, posting duplicate
  // embeds in the bet's channel. Conditional UPDATE ensures only one
  // wins.
  const claimed = await d
    .update(bets)
    .set({ dunkGifUrl: args.url, dunkPostedAt: new Date() })
    .where(and(eq(bets.id, args.betId), isNull(bets.dunkPostedAt)))
    .returning();
  if (claimed.length === 0) {
    throw new Error("dunk already posted for this bet");
  }
  await d.insert(betEvents).values({
    betId: args.betId,
    actorDiscordId: args.winnerId,
    eventType: "dunked",
    payload: { url: args.url, loserId },
  });
  return { bet, loserId };
}

/** Either participant requests an arbiter on a Funded or Disputed bet.
 *  Sets the bet to Disputed if it was Funded, marks arbiter_requested_*
 *  so the watchdog + admin DMs know to escalate. Idempotent: if already
 *  requested, returns the existing request without erroring. */
export async function requestArbiter(betId: bigint, requesterId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (requesterId !== bet.challengerId && requesterId !== bet.accepterId) {
    throw new Error("not a participant");
  }
  if (
    bet.status !== BetStatus.Funded &&
    bet.status !== BetStatus.Disputed
  ) {
    throw new Error(
      `bet is ${bet.status} — arbiter only available on Funded or Disputed bets`,
    );
  }
  if (bet.arbiterRequestedAt) {
    return { alreadyRequested: true as const, bet };
  }
  await d
    .update(bets)
    .set({
      status: BetStatus.Disputed,
      arbiterRequestedAt: new Date(),
      arbiterRequestedBy: requesterId,
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: requesterId,
    eventType: "arbiter_requested",
  });
  const refreshed = await getBet(betId);
  return { alreadyRequested: false as const, bet: refreshed! };
}

/** Admin claims an open arbiter case (sets arbiter_discord_id). Idempotent
 *  if the same admin re-claims; rejects another admin trying to take it
 *  while it's already claimed. Uses an atomic conditional UPDATE so two
 *  admins racing for the same case don't both succeed (would otherwise
 *  produce duplicate evidence-prompt DMs to participants). */
export async function claimArbiter(betId: bigint, adminId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.arbiterRequestedAt) {
    throw new Error("no arbiter request open on this bet");
  }
  if (bet.arbiterDiscordId === adminId) {
    return { alreadyClaimed: true as const, bet };
  }
  if (bet.arbiterDiscordId && bet.arbiterDiscordId !== adminId) {
    throw new Error(
      `arbiter already claimed by <@${bet.arbiterDiscordId}>`,
    );
  }
  // Atomic claim: only one admin can flip arbiterDiscordId from NULL to
  // their own id. The other admin's UPDATE affects zero rows.
  const claimed = await d
    .update(bets)
    .set({ arbiterDiscordId: adminId })
    .where(and(eq(bets.id, betId), isNull(bets.arbiterDiscordId)))
    .returning();
  if (claimed.length === 0) {
    // Race lost — refetch and surface the winning admin.
    const after = await getBet(betId);
    if (after?.arbiterDiscordId === adminId) {
      return { alreadyClaimed: true as const, bet: after };
    }
    throw new Error(
      `arbiter just claimed by <@${after?.arbiterDiscordId ?? "?"}>`,
    );
  }
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: adminId,
    eventType: "arbiter_claimed",
  });
  const refreshed = await getBet(betId);
  return { alreadyClaimed: false as const, bet: refreshed! };
}

/** Record an evidence message from a participant (sent via DM to the bot)
 *  for a bet that has an arbiter actively assigned. */
/** Cap on how many evidence rows a single participant can submit per
 *  bet — prevents an adversarial party from spamming the bot's DMs and
 *  burying the other side's evidence in /arbiter-review. */
export const MAX_EVIDENCE_PER_USER_PER_BET = 20;
/** Discord's own message-content cap, but the regular content is up to
 *  4000 chars on Nitro — clamp at 2000 since that's what /arbiter-review
 *  display assumes and prevents pathological storage. */
export const MAX_EVIDENCE_TEXT_LEN = 2000;

export async function countArbiterEvidenceForUser(
  betId: bigint,
  fromDiscordId: string,
): Promise<number> {
  const d = db();
  const rows = await d
    .select({ count: sql<number>`count(*)::int` })
    .from(betEvents)
    .where(
      and(
        eq(betEvents.betId, betId),
        eq(betEvents.eventType, "arbiter_evidence"),
        eq(betEvents.actorDiscordId, fromDiscordId),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function recordArbiterEvidence(args: {
  betId: bigint;
  fromDiscordId: string;
  text: string;
  attachmentUrls?: string[];
}): Promise<{ ok: true } | { ok: false; reason: "rate_limit" | "empty" }> {
  const trimmed = (args.text ?? "").slice(0, MAX_EVIDENCE_TEXT_LEN);
  const atts = (args.attachmentUrls ?? []).slice(0, 10);
  if (!trimmed && atts.length === 0) {
    return { ok: false, reason: "empty" };
  }
  const existing = await countArbiterEvidenceForUser(
    args.betId,
    args.fromDiscordId,
  );
  if (existing >= MAX_EVIDENCE_PER_USER_PER_BET) {
    return { ok: false, reason: "rate_limit" };
  }
  const d = db();
  await d.insert(betEvents).values({
    betId: args.betId,
    actorDiscordId: args.fromDiscordId,
    eventType: "arbiter_evidence",
    payload: { text: trimmed, attachments: atts },
  });
  return { ok: true };
}

/** Find every bet that the given user is a participant of AND that has an
 *  arbiter claimed (arbiter_discord_id IS NOT NULL). Used by the DM listener
 *  to attribute incoming evidence to the right bet. */
export async function activeArbiterBetsForParticipant(discordId: string) {
  const d = db();
  return d
    .select()
    .from(bets)
    .where(
      and(
        or(eq(bets.challengerId, discordId), eq(bets.accepterId, discordId)),
        sql`${bets.arbiterDiscordId} IS NOT NULL`,
        sql`${bets.status} = 'disputed'`,
      ),
    );
}

/** List collected evidence for an arbiter's review. */
export async function listArbiterEvidence(betId: bigint) {
  const d = db();
  return d
    .select()
    .from(betEvents)
    .where(
      and(
        eq(betEvents.betId, betId),
        eq(betEvents.eventType, "arbiter_evidence"),
      ),
    )
    .orderBy(betEvents.createdAt);
}

/** Admin arbiter decides a winner. Calls arbiter_resolve on-chain which pays
 *  the arbiter fee from the pot before settling the rest. */
export async function arbiterDecide(args: {
  betId: bigint;
  adminId: string;
  winnerDiscordId: string;
}) {
  const d = db();
  const bet = await getBet(args.betId);
  if (!bet) throw new Error("bet not found");
  if (bet.arbiterDiscordId !== args.adminId) {
    throw new Error("only the claiming arbiter can decide");
  }
  if (bet.status !== BetStatus.Disputed && bet.status !== BetStatus.Funded) {
    throw new Error(`bet is ${bet.status}, cannot arbiter-resolve`);
  }
  if (
    args.winnerDiscordId !== bet.challengerId &&
    args.winnerDiscordId !== bet.accepterId
  ) {
    throw new Error("winner must be a participant");
  }
  const chain = bet.chain as Chain;
  const winner = await getUser(args.winnerDiscordId);
  const winnerWallet = userWalletForChain(winner, chain);
  if (!winnerWallet) {
    throw new Error(`winner has no linked ${chain} wallet`);
  }
  await claimResolutionLock(args.betId, "arbiter-decide");
  let sig: string;
  try {
    sig = await chainArbiterResolve(chain, {
      betId: args.betId,
      winner: winnerWallet,
    });
  } catch (e) {
    await releaseResolutionLock(args.betId);
    throw e;
  }
  await d
    .update(bets)
    .set({
      status: BetStatus.Resolved,
      winnerId: args.winnerDiscordId,
      resolutionTxSig: sig,
      resolvedAt: new Date(),
    })
    .where(eq(bets.id, args.betId));
  await d.insert(betEvents).values({
    betId: args.betId,
    actorDiscordId: args.adminId,
    eventType: "arbiter_decided",
    payload: { sig, winner: args.winnerDiscordId, by: args.adminId },
  });
  // Reliability counters are a leaderboard side-effect; failure here
  // shouldn't mask a successful on-chain resolve. Log + continue.
  try {
    await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  } catch (e) {
    console.warn(
      `[bumpReliability] failed for bet ${bet.id} — leaderboard counters skipped:`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return { sig, winnerDiscordId: args.winnerDiscordId };
}

/** Counterparty rejects the cancel request → clear markers, no refund. */
export async function denyCancel(betId: bigint, denierId: string) {
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (!bet.cancelRequestedAt || !bet.cancelRequestedBy) {
    throw new Error("no cancel request open");
  }
  if (denierId === bet.cancelRequestedBy) {
    throw new Error("requester cannot self-deny");
  }
  const d = db();
  await d
    .update(bets)
    .set({ cancelRequestedAt: null, cancelRequestedBy: null })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: denierId,
    eventType: "cancel_deny",
  });
}

/** Refund both sides on-chain, set status. */
export async function refundBet(betId: bigint) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  if (
    bet.status !== BetStatus.Pending &&
    bet.status !== BetStatus.Funded &&
    bet.status !== BetStatus.Disputed
  ) {
    throw new Error(`bet is ${bet.status}, cannot refund`);
  }
  if (!bet.accepterId) throw new Error("bet has no accepter");
  const chain = bet.chain as Chain;
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  const challengerWallet = userWalletForChain(challenger, chain);
  const accepterWallet = userWalletForChain(accepter, chain);
  if (!challengerWallet || !accepterWallet) {
    throw new Error("participant wallets missing");
  }
  await claimResolutionLock(betId, "refund");
  let sig: string;
  try {
    sig = await chainRefund(chain, {
      betId,
      challenger: challengerWallet,
      accepter: accepterWallet,
    });
  } catch (e) {
    await releaseResolutionLock(betId);
    throw e;
  }
  await d
    .update(bets)
    .set({ status: BetStatus.Refunded, resolvedAt: new Date(), resolutionTxSig: sig })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "refunded",
    payload: { sig },
  });
  // Reliability counters are a leaderboard side-effect; failure here
  // shouldn't mask a successful on-chain resolve. Log + continue.
  try {
    await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  } catch (e) {
    console.warn(
      `[bumpReliability] failed for bet ${bet.id} — leaderboard counters skipped:`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return sig;
}

export async function listActiveBetsFor(discordId: string) {
  const d = db();
  return d
    .select()
    .from(bets)
    .where(
      and(
        or(eq(bets.challengerId, discordId), eq(bets.accepterId, discordId)),
        or(
          eq(bets.status, BetStatus.Proposed),
          eq(bets.status, BetStatus.Accepted),
          eq(bets.status, BetStatus.Pending),
          eq(bets.status, BetStatus.Funded),
          eq(bets.status, BetStatus.Disputed),
        ),
      ),
    )
    .limit(25);
}

/**
 * Aggregate per-user stats for /leaderboard. Counts each completed bet as
 * one row in the participant set; sums amounts in atomic units (USDC has 6
 * decimals so callers divide by 1e6 to display).
 *
 * @param guildId optional — restrict to bets in this guild
 * @param limit   default 10
 */
export type LeaderboardRow = {
  discordId: string;
  bets: number;
  wins: number;
  totalWagered: bigint;
  totalWon: bigint;
};

export async function leaderboardData(args: {
  guildId?: string;
  limit?: number;
}): Promise<LeaderboardRow[]> {
  const d = db();
  // Count + sum across both sides of every completed bet (resolved/drawn/refunded).
  // Drizzle SQL: union both sides, group by discord_id.
  const completedStatuses = [
    BetStatus.Resolved,
    BetStatus.Drawn,
    BetStatus.Refunded,
  ];
  const guildFilter = args.guildId
    ? sql`AND b.guild_id = ${args.guildId}`
    : sql``;
  const rows: LeaderboardRow[] = [];
  const result = await d.execute<{
    discord_id: string;
    bets: number;
    wins: number;
    total_wagered: string;
    total_won: string;
  }>(sql`
    WITH participants AS (
      SELECT
        b.challenger_id AS discord_id,
        b.id AS bet_id,
        b.amount,
        CASE WHEN b.winner_id = b.challenger_id THEN 1 ELSE 0 END AS won,
        b.amount AS payout
      FROM bets b
      WHERE b.status = ANY(${completedStatuses}::bet_status[]) ${guildFilter}
      UNION ALL
      SELECT
        b.accepter_id AS discord_id,
        b.id AS bet_id,
        b.amount,
        CASE WHEN b.winner_id = b.accepter_id THEN 1 ELSE 0 END AS won,
        b.amount AS payout
      FROM bets b
      WHERE b.status = ANY(${completedStatuses}::bet_status[]) ${guildFilter}
    )
    SELECT
      discord_id,
      COUNT(*)::int AS bets,
      SUM(won)::int AS wins,
      SUM(amount)::text AS total_wagered,
      SUM(CASE WHEN won = 1 THEN amount * 2 ELSE 0 END)::text AS total_won
    FROM participants
    GROUP BY discord_id
    ORDER BY total_won::numeric DESC
    LIMIT ${args.limit ?? 10}
  `);
  for (const r of result as unknown as Array<{
    discord_id: string;
    bets: number;
    wins: number;
    total_wagered: string;
    total_won: string;
  }>) {
    rows.push({
      discordId: r.discord_id,
      bets: r.bets,
      wins: r.wins,
      totalWagered: BigInt(r.total_wagered ?? "0"),
      totalWon: BigInt(r.total_won ?? "0"),
    });
  }
  return rows;
}

export type AdminStats = {
  total: number;
  byStatus: Record<string, number>;
  byChain: Record<"solana" | "base", number>;
  totalUsers: number;
  walletLinkedUsers: { solana: number; base: number };
  arbiter: {
    open: number; // arbiter_requested_at IS NOT NULL AND status = 'disputed'
    unclaimed: number; // also arbiter_discord_id IS NULL
    claimed: number; // also arbiter_discord_id IS NOT NULL
  };
  shareDiscountsRedeemed: number; // bets where either side has a share_url
  /** Sum of stake (in 6-dec atoms) over Resolved bets, per chain. */
  resolvedVolumeAtoms: { solana: bigint; base: bigint };
  /** Approximate total fees collected = sum(stake * (cBps + aBps) / 10000)
   *  over Resolved bets. Computed in JS since per-side bps lives on-chain
   *  not in DB; approximated using BET_FEE_BPS for both sides. */
  approxFeesCollectedAtoms: { solana: bigint; base: bigint };
};

export async function adminStats(): Promise<AdminStats> {
  const d = db();
  const rows = await d.select().from(bets);
  const userRows = await d.select().from(users);

  const byStatus: Record<string, number> = {};
  const byChain: Record<"solana" | "base", number> = { solana: 0, base: 0 };
  let openArb = 0;
  let unclaimedArb = 0;
  let claimedArb = 0;
  let sharesRedeemed = 0;
  const resolvedVolume = { solana: 0n, base: 0n };
  const fees = { solana: 0n, base: 0n };
  // Approximate per-side fee bps used when no per-bet override: BET_FEE_BPS.
  const defaultBps = BigInt(env.BET_FEE_BPS);

  for (const b of rows) {
    byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    const chain = (b.chain as "solana" | "base") ?? "solana";
    byChain[chain] += 1;
    if (b.arbiterRequestedAt && b.status === BetStatus.Disputed) {
      openArb += 1;
      if (b.arbiterDiscordId) claimedArb += 1;
      else unclaimedArb += 1;
    }
    if (b.challengerShareUrl) sharesRedeemed += 1;
    if (b.accepterShareUrl) sharesRedeemed += 1;
    if (b.status === BetStatus.Resolved) {
      const stake = BigInt(b.amount);
      resolvedVolume[chain] += stake * 2n;
      // Approximate combined fee = stake * (defaultBps + defaultBps) / 10000
      // since DB doesn't track the per-side bps that actually fired on-chain.
      fees[chain] += (stake * 2n * defaultBps) / 10_000n;
    }
  }

  const walletLinked = { solana: 0, base: 0 };
  for (const u of userRows) {
    if (u.walletPubkey) walletLinked.solana += 1;
    if (u.evmAddress) walletLinked.base += 1;
  }

  return {
    total: rows.length,
    byStatus,
    byChain,
    totalUsers: userRows.length,
    walletLinkedUsers: walletLinked,
    arbiter: { open: openArb, unclaimed: unclaimedArb, claimed: claimedArb },
    shareDiscountsRedeemed: sharesRedeemed,
    resolvedVolumeAtoms: resolvedVolume,
    approxFeesCollectedAtoms: fees,
  };
}
