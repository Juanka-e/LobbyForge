-- Role-gated channel visibility: no rows = inherited (everyone);
-- rows = only holders of the listed roles (+ owner / manage_channels /
-- administrator, enforced at the route layer).
CREATE TABLE "channel_role_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "role_id" uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "channel_role_overrides_channel_role_unique" UNIQUE ("channel_id", "role_id")
);
CREATE INDEX "idx_channel_role_overrides_channel" ON "channel_role_overrides" ("channel_id");
CREATE INDEX "idx_channel_role_overrides_role" ON "channel_role_overrides" ("role_id");
