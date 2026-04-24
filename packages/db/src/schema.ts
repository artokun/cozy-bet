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
  "refunded",
  "canceled",
  "disputed",
]);

export const users = pgTable("users", {
  discordId: text("discord_id").primaryKey(),
  walletPubkey: text("wallet_pubkey"), // null until user completes sign-message link
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }),
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
    status: betStatusEnum("status").notNull().default("proposed"),
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
