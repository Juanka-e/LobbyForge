CREATE TABLE IF NOT EXISTS "server_access_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"join_policy" text DEFAULT 'invite_only' NOT NULL,
	"external_identity" text DEFAULT 'off' NOT NULL,
	"local_account" text DEFAULT 'allow_local_email_password' NOT NULL,
	"account_linking" text DEFAULT 'allow_link' NOT NULL,
	"require_approval_for_first_join" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_access_policies_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"channel" text NOT NULL,
	"manifest_key_id" text,
	"backup_id" text,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_access_policies" ADD CONSTRAINT "server_access_policies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "system_update_runs" ADD CONSTRAINT "system_update_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_update_runs_status_started" ON "system_update_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_update_runs_started" ON "system_update_runs" USING btree ("started_at");