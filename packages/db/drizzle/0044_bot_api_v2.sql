-- Bot API v2 (docs/BOT_API_V2.md §2): per-bot channel access, slash
-- commands (+ the managers' per-command switches), interactions, incoming
-- channel webhooks and outgoing bot event endpoints.
--
-- Expand-only: six new tables and ONE new column on "bots"
-- (channel_access_mode, NOT NULL with a constant default — no table
-- rewrite; rows written by the previous image get 'all', the v1 rule), so
-- an app rollback is safe (the previous image never reads any of it).
-- Idempotent (IF NOT EXISTS everywhere — ADD COLUMN IF NOT EXISTS skips its
-- inline CHECK together with the column; table constraints are inline in
-- CREATE TABLE).
--
-- bots.channel_access_mode is the explicit §1.1 mode: 'all' = every open
-- text channel (no grants needed), 'selected' = exactly the
-- bot_channel_access rows — and NO channel when there are none. "No rows"
-- never means "all": a grant row cascades away with its channel, and that
-- must narrow a bot, never widen it.
--
-- Every table cascades with its bot / server / channel, so deleting any of
-- them leaves nothing behind. Users: a grant / webhook / override survives
-- the account that made it (SET NULL); an interaction belongs to its
-- invoker (CASCADE).
--
-- bot_command_overrides is keyed by (bot_id, name), not by the command
-- row: a bot that deletes and re-registers a command gets the managers'
-- enabled / admin_channel_ids back instead of the defaults.
--
-- bot_interactions has indexes for its channel / command FKs (a channel
-- delete cascades, a command delete sets NULL); rows are pruned by the app
-- 24 h after they expire (docs/BOT_API_V2.md §3.4). No server_id index: no
-- path deletes by server (servers are soft-deleted; a hard delete also
-- cascades through bots, whose bot_id IS indexed).
--
-- The CHECK constraints are SQL-only (like roles_icon_allowlist_check);
-- the app validates the same rules first and answers with a code, these
-- are the backstop:
--   - bots.channel_access_mode is 'all' or 'selected';
--   - command and option names follow ^[a-z0-9_-]{1,32}$ (overrides too); descriptions 1..100;
--     at most 25 options (jsonb_array_length is only evaluated inside a CASE
--     on an array — on anything else it would raise instead of failing the
--     check);
--   - interaction status is one of four values, at most 5 follow-ups;
--   - a webhook name is 1..32 characters and its token is stored only as
--     sha256$<64 hex>;
--   - an event endpoint URL is https and at most 512 characters, its secret
--     32..128 characters, its failure counter never negative.
--
-- Secrets: webhook tokens are hashed (the URL is shown once). The event
-- endpoint secret is stored as is because the server signs every delivery
-- with it (HMAC-SHA256); it is returned once and never again.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "channel_access_mode" text DEFAULT 'all' NOT NULL
  CONSTRAINT "bots_channel_access_mode_check" CHECK ("channel_access_mode" IN ('all', 'selected'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_channel_access" (
  "bot_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_channel_access_bot_id_channel_id_pk" PRIMARY KEY ("bot_id","channel_id"),
  CONSTRAINT "bot_channel_access_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_channel_access_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_channel_access_granted_by_users_id_fk"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_channel_access_channel" ON "bot_channel_access" USING btree ("channel_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bot_id" uuid NOT NULL,
  "server_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "channel_ids" jsonb,
  "admin_channel_ids" jsonb,
  "required_permission" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_commands_server_id_name_unique" UNIQUE ("server_id","name"),
  CONSTRAINT "bot_commands_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_commands_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_commands_name_check" CHECK ("name" ~ '^[a-z0-9_-]{1,32}$'),
  CONSTRAINT "bot_commands_description_length_check" CHECK (char_length("description") BETWEEN 1 AND 100),
  CONSTRAINT "bot_commands_options_check" CHECK (CASE WHEN jsonb_typeof("options") = 'array' THEN jsonb_array_length("options") <= 25 ELSE false END),
  CONSTRAINT "bot_commands_channel_ids_check" CHECK ("channel_ids" IS NULL OR jsonb_typeof("channel_ids") = 'array'),
  CONSTRAINT "bot_commands_admin_channel_ids_check" CHECK ("admin_channel_ids" IS NULL OR jsonb_typeof("admin_channel_ids") = 'array'),
  CONSTRAINT "bot_commands_required_permission_check" CHECK ("required_permission" IS NULL OR "required_permission" ~ '^[a-z_]{1,64}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_commands_bot" ON "bot_commands" USING btree ("bot_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_command_overrides" (
  "bot_id" uuid NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "admin_channel_ids" jsonb,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_command_overrides_bot_id_name_pk" PRIMARY KEY ("bot_id","name"),
  CONSTRAINT "bot_command_overrides_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_command_overrides_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "bot_command_overrides_name_check" CHECK ("name" ~ '^[a-z0-9_-]{1,32}$'),
  CONSTRAINT "bot_command_overrides_admin_channel_ids_check" CHECK ("admin_channel_ids" IS NULL OR jsonb_typeof("admin_channel_ids") = 'array')
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bot_id" uuid NOT NULL,
  "command_id" uuid,
  "server_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "command_name" text NOT NULL,
  "options" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "response" jsonb,
  "followup_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "answered_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "bot_interactions_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_interactions_command_id_bot_commands_id_fk"
    FOREIGN KEY ("command_id") REFERENCES "bot_commands"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "bot_interactions_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_interactions_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_interactions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_interactions_status_check" CHECK ("status" IN ('pending', 'answered', 'expired', 'failed')),
  CONSTRAINT "bot_interactions_command_name_check" CHECK ("command_name" ~ '^[a-z0-9_-]{1,32}$'),
  CONSTRAINT "bot_interactions_followup_count_check" CHECK ("followup_count" BETWEEN 0 AND 5),
  CONSTRAINT "bot_interactions_options_check" CHECK (jsonb_typeof("options") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_interactions_bot_status" ON "bot_interactions" USING btree ("bot_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_interactions_user" ON "bot_interactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_interactions_channel" ON "bot_interactions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_interactions_command" ON "bot_interactions" USING btree ("command_id") WHERE command_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "channel_webhooks_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "channel_webhooks_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "channel_webhooks_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "channel_webhooks_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 32),
  CONSTRAINT "channel_webhooks_token_hash_check" CHECK ("token_hash" ~ '^sha256\$[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_webhooks_channel" ON "channel_webhooks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_webhooks_server" ON "channel_webhooks" USING btree ("server_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_event_endpoints" (
  "bot_id" uuid PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "disabled_reason" text,
  "last_delivery_at" timestamp with time zone,
  "last_status" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_event_endpoints_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "bot_event_endpoints_url_check" CHECK (char_length("url") <= 512 AND "url" LIKE 'https://%'),
  CONSTRAINT "bot_event_endpoints_secret_length_check" CHECK (char_length("secret") BETWEEN 32 AND 128),
  CONSTRAINT "bot_event_endpoints_events_check" CHECK (jsonb_typeof("events") = 'array'),
  CONSTRAINT "bot_event_endpoints_failure_count_check" CHECK ("failure_count" >= 0)
);
