-- security-review AUTHZ-002: a timeout or a server mute must survive
-- leaving the server. Both lived ONLY on the memberships row; leaving
-- deletes that row and every rejoin path (invite redeem, the /lobby
-- auto-join) inserted a clean one, so a member shed a 28-day timeout in
-- seconds (create invite → leave → redeem).
--
-- server_member_sanctions holds the moderation state per (server, user),
-- outside the membership: the app mirrors every timeout / mute write here
-- and copies the row into a re-created membership. No FK to memberships on
-- purpose — the row must outlive it. Additive (expand only): the previous
-- image never reads the table, so an app rollback is safe.
CREATE TABLE IF NOT EXISTS "server_member_sanctions" (
  "server_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "timed_out_until" timestamp with time zone,
  "voice_muted" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "server_member_sanctions_server_id_user_id_pk" PRIMARY KEY ("server_id", "user_id"),
  CONSTRAINT "server_member_sanctions_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "server_member_sanctions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
-- Backfill: every membership that carries a timeout or a server mute today
-- (an expired timeout is copied as-is; it is inert either way). Idempotent.
INSERT INTO "server_member_sanctions" ("server_id", "user_id", "timed_out_until", "voice_muted")
SELECT m."server_id", m."user_id", m."timed_out_until", m."voice_muted"
FROM "memberships" m
WHERE m."timed_out_until" IS NOT NULL OR m."voice_muted" = true
ON CONFLICT ("server_id", "user_id") DO NOTHING;
