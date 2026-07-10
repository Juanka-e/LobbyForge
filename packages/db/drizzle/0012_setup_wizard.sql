-- M21 — Initial /setup wizard support.
--
-- `setup_completed_at` is the lock flag: when set, /setup redirects
-- to /lobby and subsequent /setup POSTs return 409. Nullable so an
-- instance can boot into setup mode without a manual flag flip.
--
-- `owner_user_id` points at the user row created during /setup.
-- ON DELETE SET NULL so the instance row can outlive the owner
-- (e.g. owner account deletion in /settings/my-account keeps the
-- instance bootstrapped but ownerless — re-runable from /admin).
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "setup_completed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
