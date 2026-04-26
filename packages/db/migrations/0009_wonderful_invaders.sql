CREATE TYPE "public"."chain" AS ENUM('solana', 'base');--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "chain" "chain" DEFAULT 'solana' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "evm_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_chain" "chain";