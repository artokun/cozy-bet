ALTER TABLE "bets" ADD COLUMN "counter_amount" bigint;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "counter_description" text;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "counter_by" text;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "counter_at" timestamp with time zone;