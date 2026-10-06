-- Email (docs/EMAIL.md §3.1): the verification state of an account, the
-- proof-of-address challenges (verification, email change, password reset)
-- and the mail transport + verification settings on the instance_settings
-- singleton.
--
-- Expand-only, so an app rollback is safe — the previous image never reads
-- any of it:
--   - two nullable columns on "users" (one backfilled, below);
--   - one new table, "email_tokens";
--   - eighteen columns on "instance_settings", each nullable or NOT NULL
--     with a constant default (no table rewrite).
-- Idempotent (IF NOT EXISTS everywhere; ADD COLUMN IF NOT EXISTS skips its
-- inline CHECK together with the column, and the backfill only touches
-- rows that are still NULL).
--
-- Nothing changes for an existing install: the verification mode starts
-- `off` and the mail provider `none` until an admin configures them (or
-- LOBBYFORGE_MAIL_* / LOBBYFORGE_SMTP_* / LOBBYFORGE_EMAIL_VERIFICATION in
-- the environment).
--
-- The CHECK constraints are SQL-only (like the 0045 captcha ones); the app
-- validates the same rules first and answers with a code, these are the
-- backstop:
--   - the SMTP password is only ever stored encrypted
--     (v1.<iv>.<ciphertext>.<tag>, base64url parts);
--   - the provider and region are short slugs (not an enum: adding a
--     provider to the registry must not need a migration);
--   - a token row keeps only 32-byte hashes, never the link or the code.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;--> statement-breakpoint
-- How the account was created: email verification restricts an account only
-- when its channel is in the verification scope (docs/EMAIL.md §4.2). Null
-- for every account that exists before this migration.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signup_channel" text
  CONSTRAINT "users_signup_channel_check" CHECK ("signup_channel" IS NULL OR "signup_channel" IN ('open', 'invite', 'oauth', 'setup'));--> statement-breakpoint
-- A Google identity that says its address is verified counts as verified
-- (docs/EMAIL.md §4.1) — only when it is the address the account has.
-- Re-running it changes nothing.
UPDATE "users" SET "email_verified_at" = now()
  WHERE "email_verified_at" IS NULL
    AND "email" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "user_identity_links" AS "l"
      WHERE "l"."user_id" = "users"."id" AND "l"."provider" = 'google' AND "l"."email_verified" = true
        AND lower("l"."provider_email") = "users"."email"
    );--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "target_email" text NOT NULL,
  "token_hash" bytea NOT NULL,
  "code_hash" bytea NOT NULL,
  "code_attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "code_expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_tokens_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "email_tokens_purpose_check" CHECK ("purpose" IN ('verify', 'change', 'reset')),
  CONSTRAINT "email_tokens_target_email_check" CHECK (char_length("target_email") BETWEEN 3 AND 254),
  CONSTRAINT "email_tokens_token_hash_check" CHECK (octet_length("token_hash") = 32),
  CONSTRAINT "email_tokens_code_hash_check" CHECK (octet_length("code_hash") = 32),
  CONSTRAINT "email_tokens_code_attempts_check" CHECK ("code_attempts" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_tokens_token_hash_unique" ON "email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_tokens_user_purpose_active_unique" ON "email_tokens" USING btree ("user_id","purpose") WHERE consumed_at IS NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_provider" text DEFAULT 'none' NOT NULL
  CONSTRAINT "instance_settings_mail_provider_check" CHECK ("mail_provider" ~ '^[a-z0-9-]{1,32}$');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_region" text
  CONSTRAINT "instance_settings_mail_region_check" CHECK ("mail_region" IS NULL OR "mail_region" ~ '^[a-z0-9-]{1,32}$');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "smtp_host" text
  CONSTRAINT "instance_settings_smtp_host_check" CHECK ("smtp_host" IS NULL OR char_length("smtp_host") BETWEEN 1 AND 253);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "smtp_port" integer
  CONSTRAINT "instance_settings_smtp_port_check" CHECK ("smtp_port" IS NULL OR "smtp_port" BETWEEN 1 AND 65535);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "smtp_security" text
  CONSTRAINT "instance_settings_smtp_security_check" CHECK ("smtp_security" IS NULL OR "smtp_security" IN ('tls', 'starttls', 'none'));--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "smtp_username" text
  CONSTRAINT "instance_settings_smtp_username_check" CHECK ("smtp_username" IS NULL OR char_length("smtp_username") BETWEEN 1 AND 256);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "smtp_password_encrypted" text
  CONSTRAINT "instance_settings_smtp_password_encrypted_check" CHECK ("smtp_password_encrypted" IS NULL OR "smtp_password_encrypted" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_from" text
  CONSTRAINT "instance_settings_mail_from_check" CHECK ("mail_from" IS NULL OR char_length("mail_from") BETWEEN 3 AND 320);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_daily_limit" integer
  CONSTRAINT "instance_settings_mail_daily_limit_check" CHECK ("mail_daily_limit" IS NULL OR "mail_daily_limit" BETWEEN 1 AND 10000000);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_last_test_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_last_test_result" text
  CONSTRAINT "instance_settings_mail_last_test_result_check" CHECK ("mail_last_test_result" IS NULL OR "mail_last_test_result" ~ '^[a-z_]{1,32}$');--> statement-breakpoint
-- HMAC of the connection the last test ran against: `required` unlocks only
-- while the saved configuration still has this fingerprint.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "mail_last_test_fingerprint" text
  CONSTRAINT "instance_settings_mail_last_test_fingerprint_check" CHECK ("mail_last_test_fingerprint" IS NULL OR "mail_last_test_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "email_verification_mode" text DEFAULT 'off' NOT NULL
  CONSTRAINT "instance_settings_email_verification_mode_check" CHECK ("email_verification_mode" IN ('off', 'optional', 'required'));--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "email_verification_scope" jsonb DEFAULT '{"open_register":true,"invite_register":false}'::jsonb NOT NULL
  CONSTRAINT "instance_settings_email_verification_scope_check" CHECK (jsonb_typeof("email_verification_scope") = 'object');--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "email_verification_enforced_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "email_verification_existing_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "disposable_email_block" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "disposable_email_overrides" jsonb DEFAULT '{"allow":[],"block":[]}'::jsonb NOT NULL
  CONSTRAINT "instance_settings_disposable_email_overrides_check" CHECK (jsonb_typeof("disposable_email_overrides") = 'object');
