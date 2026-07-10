ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cards_pack_category" ON "cards" USING btree ("pack_id","category");
