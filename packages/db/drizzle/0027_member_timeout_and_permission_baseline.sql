-- MODERATE_MEMBERS (timeout): the step between a warning and a kick/ban.
-- NULL / past = not timed out. Enforced on message send AND mic publish.
ALTER TABLE "memberships" ADD COLUMN "timed_out_until" timestamptz;

-- Permission baseline backfill: newly introduced @everyone permissions
-- (stream, read_message_history, mention_everyone) are appended to every
-- EXISTING server's @everyone role so current communities keep the
-- behaviour they had before the permissions became role-gated (Discord
-- does the same when shipping new @everyone permissions).
UPDATE "roles"
SET "permissions" = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements(
    "roles"."permissions" || '["stream","read_message_history","mention_everyone"]'::jsonb
  ) AS elem
)
WHERE "name" = '@everyone';
