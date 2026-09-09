-- 13th-audit: pin the REVIEWED artifact cryptographically. The
-- catalog previously approved a plugin ID while the installer later
-- downloaded whatever the (mutable) manifestUrl served — a compromised
-- publisher host silently swapped approved code. Review now records
-- the exact bundle digest; install verifies it constant-time.
ALTER TABLE "plugin_catalog" ADD COLUMN "bundle_sha256" text;
ALTER TABLE "plugin_catalog" ADD COLUMN "bundle_size_bytes" integer;
