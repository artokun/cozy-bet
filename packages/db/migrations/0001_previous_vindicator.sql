-- Add 'drawn' to bet_status enum
ALTER TYPE "public"."bet_status" ADD VALUE 'drawn' BEFORE 'refunded';--> statement-breakpoint

-- Shortcodes: nullable first → backfill → enforce NOT NULL + unique.
-- Backfill uses LEFT(MD5(id::text), 6) which is deterministic per row, so
-- re-running the migration on a half-applied DB still produces the same
-- value. Lowercased for legibility, then uppercased back. New rows go
-- through the bot's makeShortcode() which uses the 30-char alphabet.
ALTER TABLE "bets" ADD COLUMN "shortcode" text;--> statement-breakpoint
UPDATE "bets" SET "shortcode" = UPPER(LEFT(MD5(id::text), 6)) WHERE "shortcode" IS NULL;--> statement-breakpoint
ALTER TABLE "bets" ALTER COLUMN "shortcode" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "bets" ADD COLUMN "deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "nudge_24h_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "nudge_2h_sent_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "bets_by_shortcode_idx" ON "bets" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_by_deadline_idx" ON "bets" USING btree ("status","deadline");--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_shortcode_unique" UNIQUE("shortcode");
