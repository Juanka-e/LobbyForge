-- Polls in text channels (docs/CHAT_POLLS.md): a poll rides on a message
-- row (its `content` is the question, `metadata.poll.id` points at the poll)
-- and its votes live in their own table.
--
-- Expand-only, so an app rollback is safe — the previous image never reads
-- either table, and a role that carries the new permission id keeps working
-- (unknown ids grant nothing):
--   - two new tables, "message_polls" and "message_poll_votes";
--   - one backfill: the new `create_polls` permission is appended to every
--     role that already holds `administrator` or `manage_messages` (the
--     owner/admin and moderator-style roles), never to @everyone.
-- Idempotent (IF NOT EXISTS, and the backfill skips roles that already have
-- the permission).
--
-- Closing is lazy: a poll is closed once "closes_at" has passed or
-- "closed_at" is set (an early close). No job writes anything at expiry.
--
-- Anonymity: "message_poll_votes" stores WHO chose WHAT, because a vote can
-- be changed or removed and "your vote" shows on every device. No API reads
-- it except as counts and the caller's own rows; it is never written to the
-- audit log.
--
-- The CHECK constraints are SQL-only backstops; the route validates the same
-- rules first and answers with a code.
CREATE TABLE IF NOT EXISTS "message_polls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "creator_user_id" uuid,
  "question" text NOT NULL,
  "options" jsonb NOT NULL,
  "allow_multiple" boolean DEFAULT false NOT NULL,
  "closes_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "closed_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_polls_message_id_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "message_polls_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "message_polls_creator_user_id_users_id_fk"
    FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "message_polls_closed_by_user_id_users_id_fk"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "message_polls_question_check" CHECK (char_length("question") BETWEEN 1 AND 300),
  CONSTRAINT "message_polls_options_check" CHECK (jsonb_typeof("options") = 'array' AND jsonb_array_length("options") BETWEEN 2 AND 10)
);--> statement-breakpoint
-- One poll per message.
CREATE UNIQUE INDEX IF NOT EXISTS "message_polls_message_id_unique" ON "message_polls" USING btree ("message_id");--> statement-breakpoint
-- One row per (poll, voter, chosen option): a single-choice vote is one row,
-- a multiple-choice vote one row per option. The primary key's leading
-- columns serve both reads — the per-option counts of a page of polls and
-- the caller's own choices.
CREATE TABLE IF NOT EXISTS "message_poll_votes" (
  "poll_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "option_index" smallint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_poll_votes_poll_id_user_id_option_index_pk" PRIMARY KEY ("poll_id", "user_id", "option_index"),
  CONSTRAINT "message_poll_votes_poll_id_message_polls_id_fk"
    FOREIGN KEY ("poll_id") REFERENCES "message_polls"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "message_poll_votes_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "message_poll_votes_option_index_check" CHECK ("option_index" BETWEEN 0 AND 9)
);--> statement-breakpoint
-- The new permission for the roles that run the server today: owner/admin
-- roles (`administrator` grants it anyway — this keeps the role editor
-- honest) and moderator-style roles (`manage_messages`). @everyone keeps
-- what it had; owners grant polls to other roles in the role editor.
UPDATE "roles" SET "permissions" = "permissions" || '["create_polls"]'::jsonb
  WHERE "name" <> '@everyone'
    AND jsonb_typeof("permissions") = 'array'
    AND ("permissions" @> '["administrator"]'::jsonb OR "permissions" @> '["manage_messages"]'::jsonb)
    AND NOT ("permissions" @> '["create_polls"]'::jsonb);
