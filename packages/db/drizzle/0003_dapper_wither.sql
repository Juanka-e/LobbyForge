ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "maintenance_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "maintenance_message" varchar(280);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "maintenance_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "maintenance_updated_at" timestamp with time zone DEFAULT now() NOT NULL;
