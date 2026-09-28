-- Members who joined through the lobby auto-join before 0037 were created
-- with no role at all, and a member without roles has no permissions: they
-- could not read or send anywhere. Every other join path gives a newcomer
-- the server's @everyone role, and since 0037 the auto-join does too — this
-- repairs the members it created earlier. The owner (implicit
-- administrator) and anyone who already holds a role are left alone.
INSERT INTO "membership_roles" ("membership_id", "role_id")
SELECT m."id", r."id"
FROM "memberships" m
JOIN "roles" r ON r."server_id" = m."server_id" AND r."name" = '@everyone'
WHERE m."role_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "membership_roles" mr WHERE mr."membership_id" = m."id")
ON CONFLICT DO NOTHING;
