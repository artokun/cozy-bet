import { getDb, users, bets, betEvents, walletLinkSessions, allowlist } from "@cozy-bet/db";
import { BetStatus, makeShortcode, isShortcode } from "@cozy-bet/shared";
import { eq, and, or, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { nanoid } from "nanoid";
import { env } from "./env.js";
import { initializeBetOnChain, resolveOnChain, refundOnChain, drawOnChain, fetchBetOnChain } from "./solana.js";
import { disambig, termsHashOf } from "./llm.js";

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
  /** Optional deadline timestamp; default = now + 7d. */
  deadline?: Date;
  /** Tags for disambig context (challenger / accepter usernames). Optional;
   *  empty strings if not available. */
  challengerTag?: string;
  accepterTag?: string;
}): Promise<
  | { ok: true; betId: bigint; shortcode: string; termsCanonical: string }
  | { ok: false; reason: "unresolvable"; detail: string }
> {
  await upsertUser(args.challengerId);
  await upsertUser(args.accepterId);

  // Run disambig before creating the bet. If LLM rejects as unresolvable,
  // refuse to create the bet — better to make the user reword than lock
  // funds in a contract bound to ambiguous terms.
  const disambigResult = await disambig({
    userPhrase: args.description,
    challengerTag: args.challengerTag ?? args.challengerId,
    accepterTag: args.accepterTag ?? args.accepterId,
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
        amount: args.amount,
        tokenMint: args.tokenMint,
        description: args.description,
        termsCanonical,
        shortcode,
        status: BetStatus.Proposed,
        deadline,
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
    },
  });
  return { ok: true, betId, shortcode, termsCanonical };
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
  // Compute the terms hash from the canonical sentence so the on-chain bet
  // is cryptographically bound to the agreed terms. Falls back to all-zeros
  // for legacy bets that predate the canonical column.
  const termsHash = bet.termsCanonical
    ? Array.from(termsHashOf(bet.termsCanonical))
    : null;
  const { sig, betPda, vaultPda } = await initializeBetOnChain({
    betId,
    amount: BigInt(bet.amount),
    challenger: new PublicKey(challenger.walletPubkey),
    accepter: new PublicKey(accepter.walletPubkey),
    termsHash,
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

async function finalizeDraw(betId: bigint) {
  const d = db();
  const bet = await getBet(betId);
  if (!bet) throw new Error("bet not found");
  const challenger = await getUser(bet.challengerId);
  const accepter = await getUser(bet.accepterId);
  if (!challenger?.walletPubkey || !accepter?.walletPubkey) {
    throw new Error("participant wallets missing");
  }
  const sig = await drawOnChain({
    betId,
    challenger: new PublicKey(challenger.walletPubkey),
    accepter: new PublicKey(accepter.walletPubkey),
  });
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
  await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  return { outcome: "drawn" as const, sig };
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
  await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
  return { outcome: "resolved" as const, sig, winnerDiscordId };
}

/** Increment resolve_events for both participants. Increment resolve_score_good
 *  only if resolved within 24h of the deadline (or 24h of now if deadline
 *  isn't set). Called on every completed bet (resolved/drawn/refunded). */
async function bumpReliability(
  challengerId: string,
  accepterId: string,
  deadline: Date | null,
) {
  const d = db();
  const now = new Date();
  const within24h = deadline
    ? Math.abs(now.getTime() - deadline.getTime()) <= 24 * 60 * 60 * 1000
    : true; // no deadline = treat as on-time
  for (const uid of [challengerId, accepterId]) {
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
  await bumpReliability(bet.challengerId, bet.accepterId, bet.deadline);
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
