-- 10th-audit: legacy rows that predate the owner column stayed
-- listed with owner_user_id = NULL and were claimable by any user.
-- Unclaimable rows are unlisted until an administrator recovers them
-- (proof of domain/key ownership) — discovery must not surface rows
-- whose ownership nobody can vouch for.
UPDATE "registry_instances" SET "is_listed" = false WHERE "owner_user_id" IS NULL;
