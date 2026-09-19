-- Beta-readiness: persistent MUTE_MEMBERS server mute. Additive (expand
-- only) — the previous image ignores the column, so app rollback is safe.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "voice_muted" boolean DEFAULT false NOT NULL;
