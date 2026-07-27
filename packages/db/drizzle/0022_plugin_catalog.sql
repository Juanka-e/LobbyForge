-- Plugin catalog (marketplace) — community-submitted plugins with review workflow.
CREATE TABLE IF NOT EXISTS "plugin_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plugin_id" text NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "type" text NOT NULL,
  "summary" text,
  "description" text,
  "publisher" text NOT NULL,
  "publisher_user_id" uuid,
  "trust_level" text DEFAULT 'unverified' NOT NULL,
  "category" text,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "player_config" jsonb,
  "manifest_url" text,
  "icon_url" text,
  "review_status" text DEFAULT 'pending' NOT NULL,
  "reviewer_user_id" uuid,
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "requires_voice_room" boolean DEFAULT false NOT NULL,
  "download_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_catalog_publisher_user_id_users_id_fk"
    FOREIGN KEY ("publisher_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "plugin_catalog_reviewer_user_id_users_id_fk"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_catalog_plugin_id_unique" ON "plugin_catalog" ("plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugin_catalog_status" ON "plugin_catalog" USING btree ("review_status","trust_level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugin_catalog_category" ON "plugin_catalog" USING btree ("category");--> statement-breakpoint
