ALTER TABLE "users" ADD COLUMN "resolve_events" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "resolve_score_good" bigint DEFAULT 0 NOT NULL;