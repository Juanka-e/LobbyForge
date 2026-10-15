/**
 * "Something happened in this DM" for the two participants' own feeds
 * (`user:{uid}`, docs/PROFILES.md "Live updates"): the lobby's DM list
 * re-reads `GET /api/dm` — a conversation someone else started appears, the
 * newest one moves up, and one that is not open gets an unread mark.
 *
 * The `dm:{channelId}` topic only reaches a conversation that is open; this
 * reaches the list. It names the channel and who wrote, nothing else — the
 * list is read over REST, projected for that viewer. Fire-and-forget.
 */
import { publishUserEvent } from '@/lib/bots/events';

export const DM_ACTIVITY_EVENT = 'dm_activity';

export function publishDmActivity(input: { channelId: string; authorId: string; participantIds: readonly string[] }): void {
  for (const userId of new Set(input.participantIds)) {
    void publishUserEvent(userId, { type: DM_ACTIVITY_EVENT, channelId: input.channelId, fromUserId: input.authorId });
  }
}
