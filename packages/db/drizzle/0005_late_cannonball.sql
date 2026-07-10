CREATE TABLE IF NOT EXISTS "card_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"description" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cards" ADD CONSTRAINT "cards_pack_id_card_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."card_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_packs_plugin_id_slug_unique" ON "card_packs" USING btree ("plugin_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_card_packs_plugin_language" ON "card_packs" USING btree ("plugin_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cards_pack_id_ordinal_unique" ON "cards" USING btree ("pack_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cards_pack_ordinal" ON "cards" USING btree ("pack_id","ordinal");
