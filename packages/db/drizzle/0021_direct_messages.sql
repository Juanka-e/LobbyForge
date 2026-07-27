-- Instance-local direct messages (1:1 conversations, server-independent).
-- DM channels are unique per user pair; messages cascade-delete with the channel.
CREATE TABLE IF NOT EXISTS "dm_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_a_id" uuid NOT NULL,
  "user_b_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dm_channels_user_a_id_users_id_fk"
    FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "dm_channels_user_b_id_users_id_fk"
    FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "dm_channels_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_channels_pair_unique" ON "dm_channels" ("user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dm_channels_user_a" ON "dm_channels" USING btree ("user_a_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dm_channels_user_b" ON "dm_channels" USING btree ("user_b_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dm_channel_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "content" text NOT NULL,
  "reply_to_id" uuid,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dm_messages_dm_channel_id_dm_channels_id_fk"
    FOREIGN KEY ("dm_channel_id") REFERENCES "dm_channels"("id") ON DELETE cascade,
  CONSTRAINT "dm_messages_author_id_users_id_fk"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "dm_messages_reply_to_id_dm_messages_id_fk"
    FOREIGN KEY ("reply_to_id") REFERENCES "dm_messages"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dm_messages_channel_created" ON "dm_messages" USING btree ("dm_channel_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dm_messages_reply" ON "dm_messages" USING btree ("reply_to_id") WHERE reply_to_id IS NOT NULL;--> statement-breakpoint
