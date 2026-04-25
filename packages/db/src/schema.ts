import {
  pgTable,
  text,
  bigint,
  timestamp,
  boolean,
  jsonb,
  uuid,
  serial,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

/** Mirrors packages/shared/src/index.ts BetStatus. */
export const betStatusEnum = pgEnum("bet_status", [
  "proposed",
  "accepted",
  "pending",
  "funded",
  "resolved",
  "drawn",
  "refunded",
  "canceled",
  "disputed",
]);

export const users = pgTable("users", {
  discordId: text("discord_id").primaryKey(),
  walletPubkey: text("wallet_pubkey"), // null until user completes sign-message link
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }),
  /** Reliability score (cozy-bet-2tw). Updated on every completed bet:
   *  resolve_events += 1 for both participants; if resolved within 24h of
   *  the deadline, resolve_score_good += 1. Surfaced as
   *  `${good}/${events}` ratio on /saybet challenge embed + /status. */
  resolveEvents: bigint("resolve_events", { mode: "number" }).notNull().default(0),
  resolveScoreGood: bigint("resolve_score_good", { mode: "number" }).notNull().default(0),
});

export const bets = pgTable(
  "bets",
  {
    // u64 matches the Anchor `bet_id`; we use bigint here and cast in client code.
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    announceMessageId: text("announce_message_id"),
    challengerId: text("challenger_id")
      .notNull()
      .references(() => users.discordId),
    accepterId: text("accepter_id")
      .notNull()
      .references(() => users.discordId),
    // Amount in atomic units of the mint (e.g. 50_000_000 = 50 tokens @ 6 decimals).
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    tokenMint: text("token_mint").notNull(),
    description: text("description").notNull(),
    /** Canonical sentence after LLM disambig (or description verbatim if
     *  ANTHROPIC_API_KEY is unset). This is what's keccak'd into the
     *  on-chain terms_hash + what both parties EIP-712 sign off-chain. */
    termsCanonical: text("terms_canonical"),
    /** Short user-facing bet id (e.g. "K7M2RX"). Unique per row. Lowercase
     *  base32-ish (no I, L, O, 0, 1 to avoid confusion). Populated on insert. */
    shortcode: text("shortcode").notNull().unique(),
    status: betStatusEnum("status").notNull().default("proposed"),
    /** When the bet auto-expires if unresolved. Set on /saybet. Used by the
     *  watchdog to send 24h/2h nudges and trigger arbiter handoff after. */
    deadline: timestamp("deadline", { withTimezone: true }),
    nudge24hSentAt: timestamp("nudge_24h_sent_at", { withTimezone: true }),
    nudge2hSentAt: timestamp("nudge_2h_sent_at", { withTimezone: true }),
    // On-chain state (null until initialize_bet runs)
    betPda: text("bet_pda"),
    vaultPda: text("vault_pda"),
    initTxSig: text("init_tx_sig"),
    // Per-side deposit tracking (independent of on-chain; the bot reconciles)
    challengerDeposited: boolean("challenger_deposited").notNull().default(false),
    accepterDeposited: boolean("accepter_deposited").notNull().default(false),
    // Resolution claims. Each party can claim a winner; when both claims match, bot resolves.
    challengerClaimsWinner: text("challenger_claims_winner"), // discord_id claim
    accepterClaimsWinner: text("accepter_claims_winner"),
    // Draw claims (parallel to winner claims). Bool — when both true, bot calls draw() on-chain.
    challengerClaimsDraw: boolean("challenger_claims_draw").notNull().default(false),
    accepterClaimsDraw: boolean("accepter_claims_draw").notNull().default(false),
    winnerId: text("winner_id"), // finalized winner after on-chain resolve
    resolutionTxSig: text("resolution_tx_sig"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    byChallenger: index("bets_by_challenger_idx").on(table.challengerId),
    byAccepter: index("bets_by_accepter_idx").on(table.accepterId),
    byStatus: index("bets_by_status_idx").on(table.status),
    byShortcode: uniqueIndex("bets_by_shortcode_idx").on(table.shortcode),
    /** Watchdog scans for {pending|funded} bets with deadlines coming due. */
    byDeadline: index("bets_by_deadline_idx").on(table.status, table.deadline),
  }),
);

export const betEvents = pgTable(
  "bet_events",
  {
    id: serial("id").primaryKey(),
    betId: bigint("bet_id", { mode: "bigint" })
      .notNull()
      .references(() => bets.id, { onDelete: "cascade" }),
    actorDiscordId: text("actor_discord_id"),
    eventType: text("event_type").notNull(), // 'proposed','accepted','deposited','claim_win','cancel_request','resolved','refunded','disputed','admin_override'
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byBet: index("bet_events_by_bet_idx").on(table.betId, table.createdAt),
  }),
);

export const walletLinkSessions = pgTable(
  "wallet_link_sessions",
  {
    nonce: text("nonce").primaryKey(),
    discordId: text("discord_id")
      .notNull()
      .references(() => users.discordId),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => ({
    byDiscord: index("wls_by_discord_idx").on(table.discordId),
  }),
);

/** Optional: explicit allowlist for closed-group deployments. When rows exist,
 *  the bot refuses to engage with discord users not on this list. */
export const allowlist = pgTable("allowlist", {
  discordId: text("discord_id").primaryKey(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Bet = typeof bets.$inferSelect;
export type NewBet = typeof bets.$inferInsert;
export type BetEvent = typeof betEvents.$inferSelect;
export type NewBetEvent = typeof betEvents.$inferInsert;
export type WalletLinkSession = typeof walletLinkSessions.$inferSelect;
export type NewWalletLinkSession = typeof walletLinkSessions.$inferInsert;
