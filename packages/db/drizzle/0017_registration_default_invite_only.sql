-- New instance instances default to invite_only registration for launch hardening.
-- Existing rows keep their stored value; this only changes the column default so
-- freshly provisioned instances (and the no-settings-row app fallback) are closed
-- by default. An owner can still open registration from Admin > Authentication.
ALTER TABLE "instance_settings" ALTER COLUMN "registration_mode" SET DEFAULT 'invite_only';--> statement-breakpoint
