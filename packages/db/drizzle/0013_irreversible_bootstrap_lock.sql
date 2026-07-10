-- Make first-run setup a one-way state transition.
-- Version 2 means the instance was provisioned with credentials and a server;
-- operational damage must be repaired through authenticated admin tooling.
ALTER TABLE "instance_settings"
  ADD COLUMN IF NOT EXISTS "bootstrap_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- Backfill installations completed by the credentialed bootstrap flow that
-- shipped before this explicit version column. Incomplete legacy M21 rows stay
-- at version 1 and may be repaired once with the setup token.
UPDATE "instance_settings" AS i
SET "bootstrap_version" = 2
WHERE i."setup_completed_at" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "users" AS u
    WHERE u."id" = i."owner_user_id"
      AND u."email" IS NOT NULL
      AND u."password_hash" IS NOT NULL
  )
  AND EXISTS (
    SELECT 1
    FROM "servers" AS s
    WHERE s."owner_user_id" = i."owner_user_id"
      AND s."deleted_at" IS NULL
  );
