-- Languages saved per account, and an instance default chosen in the admin
-- panel or at /setup (docs/TRANSLATING.md).
--
-- users.locale: was NOT NULL DEFAULT 'en', and nothing in the app ever wrote
-- it, so every 'en' in it means "never chose", not "chose English". It
-- becomes nullable with no default — NULL = follow the browser — and the
-- existing 'en' rows are cleared, so that from now on an 'en' is an explicit
-- English choice. The three changes run in one guarded block that only fires
-- while the column is still NOT NULL: re-running this file can never clear
-- an English choice made after the first run.
--
-- instance_settings.default_locale: new, nullable. NULL = not chosen, which
-- falls back to LOBBYFORGE_DEFAULT_LOCALE and then English. The app checks
-- the stored code against the installed languages on every read.
--
-- Rollback: the previous image treats a NULL users.locale like 'en' (its
-- mail code already checks for a falsy value), so it keeps working. Accounts
-- it creates while rolled back get 'en' written explicitly, which this image
-- reads as an English choice.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'locale'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;
    ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;
    UPDATE "users" SET "locale" = NULL WHERE "locale" = 'en';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "default_locale" text;
