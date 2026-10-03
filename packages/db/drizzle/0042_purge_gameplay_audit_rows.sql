-- security-review PLUG-001 follow-up: purge the audit rows that leaked
-- hidden game information, written before the fix. Until then the
-- activity actions route logged EVERY action as `activity.action`
-- {pluginId, actionType} with the actor, and VIEW_AUDIT_LOG holders could
-- read who sent Vampire Village night actions and pack chat (hidden roles)
-- and line poll `vote` rows up with the counts (anonymous voters). The
-- route no longer writes member/player actions.
--
-- Only those two plugins' player rows go. Other plugins' old rows reveal
-- nothing secret, and some of them were HOST actions under earlier
-- versions (Watch Party's set-video/play/pause/seek/end were host-only
-- before 2026-09-29) — they are moderation history and stay, as do all
-- host actions (start, configure, kick, reveal, …).
--
-- Data-only and idempotent: re-running deletes nothing new. No schema
-- change (the snapshot is unchanged apart from its id).
DELETE FROM "audit_logs"
WHERE "action" = 'activity.action'
  AND (
    ("metadata"->>'pluginId' = 'vampire-village' AND "metadata"->>'actionType' IN
      ('join', 'leave', 'set-ready', 'timeout', 'night-target', 'night-shield', 'vote', 'chat', 'pack-chat'))
    OR ("metadata"->>'pluginId' = 'poll' AND "metadata"->>'actionType' IN ('vote'))
  );
