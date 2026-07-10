ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "registration_mode" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "guest_access_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "seo_indexing_enabled" boolean DEFAULT false NOT NULL;
