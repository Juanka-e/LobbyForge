ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "seo_title" varchar(70);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "seo_description" varchar(160);
