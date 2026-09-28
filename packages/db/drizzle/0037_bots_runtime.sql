-- Bots milestone: bot tokens, the Bot API v1 and the built-in Welcome /
-- Moderation bots. Expand-only — every change is additive and nothing the
-- previous image reads changes meaning, so an app rollback stays safe.
--
-- bots: the token is shown once and only its hash is kept (`token_hash`,
-- already present); `token_issued_at` dates the current token, `settings`
-- holds the built-in bots' configuration, `created_by` is the "installed
-- by" on the bot profile, `last_used_at` the bot's last activity.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "created_by" uuid;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- `permissions` is a JSON ARRAY of bot permission ids, but the column
-- was created with an object default. No code ever inserted a bot, so
-- this only normalises hand-made rows; then the default is corrected.
UPDATE "bots" SET "permissions" = '[]'::jsonb WHERE jsonb_typeof("permissions") <> 'array';--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "permissions" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bots_server" ON "bots" USING btree ("server_id");--> statement-breakpoint
-- One Welcome Bot and one Moderation Bot per server; custom bots are not
-- limited here (the app caps them). A partial unique index, so it lives
-- in SQL only — see the note on `bots` in schema.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "bots_server_builtin_type_unique" ON "bots" USING btree ("server_id","type") WHERE "type" IN ('welcome', 'moderation');--> statement-breakpoint
-- messages: a bot-authored message has user_id NULL and bot_id set. Only
-- the server writes it (the Bot API and the built-in bots). ON DELETE SET
-- NULL keeps the conversation when a bot is deleted; the message's
-- metadata.bot snapshot still names the bot that wrote it.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_bot" ON "messages" USING btree ("bot_id") WHERE bot_id IS NOT NULL;
