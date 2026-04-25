ALTER TABLE "bets" ALTER COLUMN "accepter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "is_open" boolean DEFAULT false NOT NULL;