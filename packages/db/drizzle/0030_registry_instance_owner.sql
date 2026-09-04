-- SEC-007: directory instance ownership. registry_instances had no owner —
-- any authenticated user could upsert over an existing, admin-listed
-- instance (name/domain swap = discovery phishing vector). The first
-- registrant becomes the owner; legacy rows (owner NULL) are claimed by
-- the first legitimate updater, then locked to that owner.
ALTER TABLE "registry_instances" ADD COLUMN "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
