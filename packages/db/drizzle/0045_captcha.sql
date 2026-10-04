-- Bot protection (docs/CAPTCHA.md §3.1): the CAPTCHA provider, the four
-- protected surfaces, the provider keys and options, and the manual attack
-- mode switch, all on the instance_settings singleton.
--
-- Expand-only: six new columns on "instance_settings", each nullable or NOT
-- NULL with a constant default (no table rewrite), so an app rollback is
-- safe — the previous image never reads any of them. Idempotent (ADD COLUMN
-- IF NOT EXISTS skips its inline CHECK together with the column).
--
-- An existing install gets the contract defaults on upgrade: the built-in
-- ALTCHA provider, sign-up and new guests protected, adaptive sign-in.
-- LOBBYFORGE_CAPTCHA_PROVIDER=none (environment) switches it off without a
-- database write.
--
-- The CHECK constraints are SQL-only (like roles_icon_allowlist_check);
-- the admin API validates the same rules first and answers with a code,
-- these are the backstop:
--   - the provider is one of four values;
--   - surfaces and options are JSON objects (their keys are validated by
--     the app, which fills in defaults for anything missing);
--   - the site key is at most 256 characters;
--   - the secret is only ever stored encrypted: v1.<iv>.<ciphertext>.<tag>,
--     base64url parts — a plaintext secret cannot land in this column.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_provider" text DEFAULT 'altcha' NOT NULL
  CONSTRAINT "instance_settings_captcha_provider_check" CHECK ("captcha_provider" IN ('none', 'altcha', 'turnstile', 'recaptcha'));--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_surfaces" jsonb DEFAULT '{"register":"on","invite_register":"off","guest":"on","login":"adaptive"}'::jsonb NOT NULL
  CONSTRAINT "instance_settings_captcha_surfaces_check" CHECK (jsonb_typeof("captcha_surfaces") = 'object');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_site_key" text
  CONSTRAINT "instance_settings_captcha_site_key_check" CHECK ("captcha_site_key" IS NULL OR char_length("captcha_site_key") BETWEEN 1 AND 256);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_secret_encrypted" text
  CONSTRAINT "instance_settings_captcha_secret_encrypted_check" CHECK ("captcha_secret_encrypted" IS NULL OR "captcha_secret_encrypted" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_options" jsonb DEFAULT '{}'::jsonb NOT NULL
  CONSTRAINT "instance_settings_captcha_options_check" CHECK (jsonb_typeof("captcha_options") = 'object');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "captcha_attack_mode" boolean DEFAULT false NOT NULL;
