ALTER TABLE "bets" ADD COLUMN "parent_bet_id" bigint;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "chain_depth" bigint DEFAULT 0 NOT NULL;