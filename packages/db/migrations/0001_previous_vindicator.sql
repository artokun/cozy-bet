ALTER TYPE "public"."bet_status" ADD VALUE 'drawn' BEFORE 'refunded';--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "shortcode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "nudge_24h_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "nudge_2h_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bets_by_shortcode_idx" ON "bets" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_by_deadline_idx" ON "bets" USING btree ("status","deadline");--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_shortcode_unique" UNIQUE("shortcode");