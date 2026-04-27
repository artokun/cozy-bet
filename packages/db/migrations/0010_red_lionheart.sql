ALTER TABLE "bets" ADD COLUMN "arbiter_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "arbiter_requested_by" text;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "arbiter_discord_id" text;