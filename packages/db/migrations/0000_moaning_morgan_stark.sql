CREATE TYPE "public"."bet_status" AS ENUM('proposed', 'accepted', 'pending', 'funded', 'resolved', 'refunded', 'canceled', 'disputed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "allowlist" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bet_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"bet_id" bigint NOT NULL,
	"actor_discord_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bets" (
	"id" bigint PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"announce_message_id" text,
	"challenger_id" text NOT NULL,
	"accepter_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"token_mint" text NOT NULL,
	"description" text NOT NULL,
	"status" "bet_status" DEFAULT 'proposed' NOT NULL,
	"bet_pda" text,
	"vault_pda" text,
	"init_tx_sig" text,
	"challenger_deposited" boolean DEFAULT false NOT NULL,
	"accepter_deposited" boolean DEFAULT false NOT NULL,
	"challenger_claims_winner" text,
	"accepter_claims_winner" text,
	"winner_id" text,
	"resolution_tx_sig" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"funded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"wallet_pubkey" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_link_sessions" (
	"nonce" text PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bet_events" ADD CONSTRAINT "bet_events_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bets" ADD CONSTRAINT "bets_challenger_id_users_discord_id_fk" FOREIGN KEY ("challenger_id") REFERENCES "public"."users"("discord_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bets" ADD CONSTRAINT "bets_accepter_id_users_discord_id_fk" FOREIGN KEY ("accepter_id") REFERENCES "public"."users"("discord_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_link_sessions" ADD CONSTRAINT "wallet_link_sessions_discord_id_users_discord_id_fk" FOREIGN KEY ("discord_id") REFERENCES "public"."users"("discord_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bet_events_by_bet_idx" ON "bet_events" USING btree ("bet_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_by_challenger_idx" ON "bets" USING btree ("challenger_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_by_accepter_idx" ON "bets" USING btree ("accepter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_by_status_idx" ON "bets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wls_by_discord_idx" ON "wallet_link_sessions" USING btree ("discord_id");