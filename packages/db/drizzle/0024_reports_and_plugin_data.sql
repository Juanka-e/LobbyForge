-- Instance reports (discovery directory complaints) + plugin data (generic storage).
CREATE TABLE IF NOT EXISTS "instance_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" text NOT NULL,
  "reporter_user_id" uuid,
  "reason" text NOT NULL,
  "detail" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "reviewer_user_id" uuid,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "instance_reports_reporter_user_id_users_id_fk"
    FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "instance_reports_reviewer_user_id_users_id_fk"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_reports_instance" ON "instance_reports" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_reports_status" ON "instance_reports" USING btree ("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plugin_data" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid,
  "plugin_id" text NOT NULL,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_data_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_data_server_plugin_key_unique" ON "plugin_data" ("server_id","plugin_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugin_data_plugin" ON "plugin_data" USING btree ("plugin_id","server_id");--> statement-breakpoint

ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "banner_url" text;--> statement-breakpoint
