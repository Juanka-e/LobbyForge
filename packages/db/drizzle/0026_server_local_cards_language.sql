-- NEW-007: language scope for server-local cards.
-- NULL = shared across all languages; a value like 'tr' restricts the
-- card to packs of that language so a Turkish local word never leaks
-- into a German deck (the deck loader filters on language IS NULL OR
-- language = <pack language>).

ALTER TABLE "server_local_cards" ADD COLUMN "language" text;
CREATE INDEX "idx_server_local_cards_server_plugin_language" ON "server_local_cards" USING btree ("server_id", "plugin_id", "language");
