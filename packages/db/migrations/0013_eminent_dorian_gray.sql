ALTER TABLE "bets" ADD COLUMN "challenger_share_url" text;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "accepter_share_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "x_handle" text;