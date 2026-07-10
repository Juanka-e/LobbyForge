CREATE TABLE IF NOT EXISTS "membership_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_roles_membership_id_role_id_unique" UNIQUE("membership_id","role_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_membership_roles_membership" ON "membership_roles" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_membership_roles_role" ON "membership_roles" USING btree ("role_id");
--> statement-breakpoint
-- Backfill: any existing membership that already had a roleId gets the
-- same role mirrored into membership_roles so the union read path
-- (memberships.roleId ∪ membership_roles) returns the right set
-- without the application having to backfill at boot.
INSERT INTO "membership_roles" ("membership_id", "role_id")
SELECT m.id, m.role_id
FROM "memberships" m
WHERE m.role_id IS NOT NULL
ON CONFLICT ("membership_id", "role_id") DO NOTHING;