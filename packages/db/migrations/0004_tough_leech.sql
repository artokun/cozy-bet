ALTER TABLE "bets" ADD COLUMN "challenger_claims_draw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "accepter_claims_draw" boolean DEFAULT false NOT NULL;