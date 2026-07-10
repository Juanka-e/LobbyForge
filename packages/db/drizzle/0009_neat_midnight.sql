CREATE TABLE IF NOT EXISTS "component_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_type" text NOT NULL,
	"component_id" text NOT NULL,
	"version" integer NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_migrations_type_id_version_unique" UNIQUE("component_type","component_id","version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_component_migrations_component" ON "component_migrations" USING btree ("component_type","component_id");