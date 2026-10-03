-- Security follow-up to AUTHZ-004: the join approval queue.
--
-- An access policy that holds newcomers for a moderator
-- (`requireApprovalForFirstJoin`, `joinPolicy = public_with_approval`,
-- `accountLinking = require_admin_approval_first_join`) used to turn every
-- new member away, because there was nowhere to hold them. An invite redeem
-- or the /lobby auto-join now files a row here instead of a membership; a
-- moderator approves it (the membership is created then, with any stored
-- sanction) or rejects it, and the requester can cancel it.
--
-- At most ONE pending request per (server, user): a partial unique index
-- (the table builder cannot express it, so it lives here only, like
-- game_sessions_channel_open_unique). The CHECK constraints are SQL-only
-- too, like roles_icon_allowlist_check. Decided rows are kept as the record
-- of who decided what; decided_by survives the moderator's account (SET NULL).
-- rejected_by_ban marks a rejection written BY a ban (banning a user rejects
-- their pending request; approval rejects a user banned meanwhile): the
-- rejection cooldown ignores it, so once the ban is lifted or expires the
-- user may ask again at once instead of waiting out a moderator cooldown.
--
-- Also: server_access_policies.join_policy defaults to
-- 'public_self_register', the policy a server WITHOUT a row has always
-- enforced (registration only checks a saved row). The app writes the
-- column on every insert, so this changes no existing row and no behaviour;
-- it keeps the column default equal to the displayed default.
--
-- Additive (expand only): the previous image never reads the table and
-- always writes join_policy, so an app rollback is safe. Idempotent.
CREATE TABLE IF NOT EXISTS "server_join_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "source" text NOT NULL,
  "invite_code" varchar(16),
  "note" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" uuid,
  "rejected_by_ban" boolean DEFAULT false NOT NULL,
  CONSTRAINT "server_join_requests_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "server_join_requests_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "server_join_requests_decided_by_users_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "server_join_requests_source_check" CHECK ("source" IN ('invite', 'auto_join')),
  CONSTRAINT "server_join_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT "server_join_requests_note_length_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_join_requests_one_pending_unique" ON "server_join_requests" USING btree ("server_id","user_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_join_requests_server_status" ON "server_join_requests" USING btree ("server_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_join_requests_server_user" ON "server_join_requests" USING btree ("server_id","user_id");--> statement-breakpoint
ALTER TABLE "server_access_policies" ALTER COLUMN "join_policy" SET DEFAULT 'public_self_register';
