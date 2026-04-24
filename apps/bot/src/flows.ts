import { getDb, users, bets, betEvents, walletLinkSessions, allowlist } from "@cozy-bet/db";
import { BetStatus } from "@cozy-bet/shared";
import { eq, and, or } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { nanoid } from "nanoid";
import { env } from "./env.js";
import { initializeBetOnChain, resolveOnChain, refundOnChain, fetchBetOnChain } from "./solana.js";

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
  await d
    .update(users)
    .set({ walletPubkey, linkedAt: new Date() })
    .where(eq(users.discordId, discordId));
}

export async function proposeBet(args: {
  guildId: string;
  channelId: string;
  challengerId: string;
  accepterId: string;
  amount: bigint;
  description: string;
  tokenMint: string;
}) {
  await upsertUser(args.challengerId);
  await upsertUser(args.accepterId);
  const betId = BigInt(Date.now()) * 4096n + BigInt(Math.floor(Math.random() * 4096));
  const d = db();
  await d.insert(bets).values({
    id: betId,
    guildId: args.guildId,
    channelId: args.channelId,
    challengerId: args.challengerId,
    accepterId: args.accepterId,
    amount: args.amount,
    tokenMint: args.tokenMint,
    description: args.description,
    status: BetStatus.Proposed,
  });
  await d.insert(betEvents).values({
    betId,
    actorDiscordId: args.challengerId,
    eventType: "proposed",
    payload: { amount: args.amount.toString(), description: args.description },
  });
  return betId;
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
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  if (!challenger?.walletPubkey || !accepter?.walletPubkey) {
    throw new Error("both users must link their wallets first");
  }
  const { sig, betPda, vaultPda } = await initializeBetOnChain({
    betId,
    amount: BigInt(bet.amount),
    challenger: new PublicKey(challenger.walletPubkey),
    accepter: new PublicKey(accepter.walletPubkey),
  });
  const d = db();
  await d
    .update(bets)
    .set({
      status: BetStatus.Pending,
      betPda: betPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      initTxSig: sig,
    })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "initialized",
    payload: { sig, betPda: betPda.toBase58() },
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

  const onChain = await fetchBetOnChain(betId);
  if (!onChain) throw new Error("on-chain bet not found");

  const patch: Partial<typeof bets.$inferInsert> = {
    challengerDeposited: onChain.challengerDeposited,
    accepterDeposited: onChain.accepterDeposited,
  };
  const wasNotFunded = bet.status !== BetStatus.Funded;
  const isNowFunded = "funded" in onChain.status;
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
  const onChain = await fetchBetOnChain(betId);
  if (!onChain) return { changed: false, reason: "no on-chain state yet" };

  const patch: Partial<typeof bets.$inferInsert> = {};
  if (bet.challengerDeposited !== onChain.challengerDeposited) {
    patch.challengerDeposited = onChain.challengerDeposited;
  }
  if (bet.accepterDeposited !== onChain.accepterDeposited) {
    patch.accepterDeposited = onChain.accepterDeposited;
  }
  // Map on-chain enum to DB enum
  const onChainStatus =
    "pending" in onChain.status
      ? BetStatus.Pending
      : "funded" in onChain.status
        ? BetStatus.Funded
        : "resolved" in onChain.status
          ? BetStatus.Resolved
          : "refunded" in onChain.status
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
      (onChainStatus === BetStatus.Resolved || onChainStatus === BetStatus.Refunded) &&
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

async function finalizeResolve(betId: bigint, winnerDiscordId: string) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  const winner = await getUser(winnerDiscordId);
  if (!winner?.walletPubkey) throw new Error("winner has no linked wallet");

  const sig = await resolveOnChain({
    betId,
    winner: new PublicKey(winner.walletPubkey),
  });
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
  return { outcome: "resolved" as const, sig, winnerDiscordId };
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
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  if (!challenger?.walletPubkey || !accepter?.walletPubkey) {
    throw new Error("participant wallets missing");
  }
  const sig = await refundOnChain({
    betId,
    challenger: new PublicKey(challenger.walletPubkey),
    accepter: new PublicKey(accepter.walletPubkey),
  });
  await d
    .update(bets)
    .set({ status: BetStatus.Refunded, resolvedAt: new Date(), resolutionTxSig: sig })
    .where(eq(bets.id, betId));
  await d.insert(betEvents).values({
    betId,
    eventType: "refunded",
    payload: { sig },
  });
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
