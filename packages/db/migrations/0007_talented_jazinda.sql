ALTER TABLE "bets" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "cancel_requested_by" text;