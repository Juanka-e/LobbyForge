CREATE TABLE IF NOT EXISTS "system_update_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "system_update_events" ADD CONSTRAINT "system_update_events_run_id_system_update_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."system_update_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_update_events_run_created" ON "system_update_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_system_update_events_run_step" ON "system_update_events" USING btree ("run_id","step_id");