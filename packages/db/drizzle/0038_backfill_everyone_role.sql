-- Members who joined through the lobby auto-join before 0037 were created
-- with no role at all, and a member without roles has no permissions: they
-- could not read or send anywhere. Every other join path gives a newcomer
-- the server's @everyone role, and since 0037 the auto-join does too — this
-- repairs the members it created earlier.
--
-- Left alone: the owner (implicit administrator), anyone who holds a role,
-- and anyone whose roles a moderator set by hand (`member.set_roles` in the
-- audit log) — an empty role set there is a deliberate lock-out, not a
-- missed default. Role names are not unique, so each server's real
-- @everyone is the lowest-positioned, oldest role of that name.
INSERT INTO "membership_roles" ("membership_id", "role_id")
SELECT m."id", e."id"
FROM "memberships" m
JOIN (
  SELECT DISTINCT ON ("server_id") "id", "server_id"
  FROM "roles"
  WHERE "name" = '@everyone'
  ORDER BY "server_id", "position" ASC, "created_at" ASC
) e ON e."server_id" = m."server_id"
WHERE m."role_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "membership_roles" mr WHERE mr."membership_id" = m."id")
  AND NOT EXISTS (
    SELECT 1 FROM "audit_logs" a
    WHERE a."server_id" = m."server_id"
      AND a."action" = 'member.set_roles'
      AND a."target_id" = m."user_id"::text
  )
ON CONFLICT DO NOTHING;
