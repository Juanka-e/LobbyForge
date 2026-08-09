-- Add revision column to game_sessions for optimistic concurrency control.
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
