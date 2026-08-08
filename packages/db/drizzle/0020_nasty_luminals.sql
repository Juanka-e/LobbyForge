ALTER TABLE "roles" ADD COLUMN "display_separately" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "roles" AS legacy
SET "name" = 'Owner'
WHERE legacy."name" = '@admin'
  AND NOT EXISTS (
    SELECT 1
    FROM "roles" AS existing_role
    WHERE existing_role."server_id" = legacy."server_id"
      AND existing_role."name" = 'Owner'
  );
