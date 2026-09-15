-- 14th-audit: legacy approved rows have no artifact pin — under the
-- pinned model, "approved" must mean "these exact bytes were reviewed".
-- Push unpinned approved plugins back to the review queue; installs of
-- unpinned rows are additionally refused at the route level (fail closed).
UPDATE "plugin_catalog"
SET "review_status" = 'pending'
WHERE "review_status" = 'approved' AND "bundle_sha256" IS NULL;
