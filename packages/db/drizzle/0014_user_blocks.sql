-- User blocks table — per-user directional block list.
-- When user A blocks user B, A sees B's chat messages masked as "Blocked user".
-- The message row stays (so the conversation flow makes sense); the author +
-- content are hidden from the blocker's UI.

CREATE TABLE IF NOT EXISTS "user_blocks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "blocker_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
    "blocked_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "user_blocks_blocker_blocked_unique" UNIQUE("blocker_user_id", "blocked_user_id")
);

CREATE INDEX IF NOT EXISTS "idx_user_blocks_blocker" ON "user_blocks" ("blocker_user_id");
