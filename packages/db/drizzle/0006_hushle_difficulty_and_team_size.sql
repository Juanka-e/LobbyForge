-- M20a — Hushle difficulty tiers + server-local cards + per-channel mutex
-- at the DB layer.
--
-- 1. `cards.difficulty` — plugin-defined tier label (Hushle uses
--    easy/medium/hard; other plugins can store any string or ignore it).
-- 2. `server_local_cards` — custom card additions scoped to a single
--    server. The reducer's deck loader will union these with the
--    global pack cards in M20b.
-- 3. `game_sessions.team_size` + `difficulty_distribution` — plugin-
--    defined knobs the host reads when calling `createInitialState`.
-- 4. Partial unique index on `game_sessions(channelId) WHERE status IN
--    ('lobby', 'running', 'paused')` — defence-in-depth for the per-
--    channel mutex enforced in the activity start route (apps/web/app/
--    api/servers/[id]/channels/[channelId]/activities/route.ts).
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "difficulty" text DEFAULT 'easy' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cards_pack_difficulty" ON "cards" USING btree ("pack_id","difficulty");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_local_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"category" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"difficulty" text DEFAULT 'easy' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_local_cards" ADD CONSTRAINT "server_local_cards_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_local_cards" ADD CONSTRAINT "server_local_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_local_cards_server_plugin" ON "server_local_cards" USING btree ("server_id","plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_local_cards_server_plugin_difficulty" ON "server_local_cards" USING btree ("server_id","plugin_id","difficulty");--> statement-breakpoint
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "team_size" integer;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "difficulty_distribution" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "game_sessions_channel_open_unique" ON "game_sessions" USING btree ("channel_id") WHERE status IN ('lobby', 'running', 'paused');
