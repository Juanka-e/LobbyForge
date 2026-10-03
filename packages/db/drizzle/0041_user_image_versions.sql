-- security-review FILE-001: explicit cache versions for user images.
-- The image route's `?v=` token was md5(users.updated_at, byte length),
-- and updated_at moves on EVERY profile edit (status text, bio, display
-- name). Editing a status every few seconds therefore invalidated the
-- token each time, forcing every viewer to re-download — and the server to
-- re-decode — a multi-MB avatar / banner on each lobby load.
--
-- The app bumps avatar_version / banner_version on every write of
-- avatar_url / banner_url (and on nothing else) and builds the token from
-- them. Existing rows start at 0: their token changes once on deploy.
-- Additive (expand only): the previous image ignores both columns, so an
-- app rollback is safe. Idempotent.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banner_version" integer DEFAULT 0 NOT NULL;
