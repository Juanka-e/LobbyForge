-- Profile fields: a handle, pronouns and a profile colour (docs/PROFILES.md
-- "Profile fields").
--
-- users.username: the account's unique handle, shown as `@name` under the
-- display name and resolvable as a mention without the picker. Stored
-- lowercase; the CHECK keeps the format (2–32 of a-z 0-9 _ .) and the
-- unique constraint keeps one owner per handle. NULL = no handle — every
-- existing account and every guest — and Postgres lets any number of NULLs
-- share a unique column.
--
-- users.pronouns: free text, at most 40 characters. NULL = none.
--
-- users.accent_color: `#rrggbb` lowercase, the card's band when there is no
-- banner. NULL = derived from the avatar, as before.
--
-- Expand-only and idempotent: three nullable columns and two named
-- constraints, each added only when missing; nothing is rewritten or
-- dropped. Rollback: the previous image never reads the columns, so profiles
-- simply lose the three fields until the next upgrade.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pronouns" varchar(40);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent_color" varchar(7);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE ("username");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_format') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("username" ~ '^[a-z0-9_.]{2,32}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_accent_color_format') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_accent_color_format" CHECK ("accent_color" ~ '^#[0-9a-f]{6}$');
  END IF;
END $$;
