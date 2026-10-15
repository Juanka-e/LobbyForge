/**
 * "You were mentioned" for each member a new message names
 * (docs/PROFILES.md "Mentions"): an event on that member's own feed
 * (`user:{uid}`), which the lobby turns into a red badge on the channel
 * and, while the tab is hidden, a desktop notification — wherever in the
 * community they are looking.
 *
 * Only members who may READ that channel hear it (a mention in a private
 * channel they cannot see notifies nobody, as in Discord), never the author,
 * and never someone who blocked the author. The event names the server,
 * channel, message and author — no text: the lobby reads the message over
 * REST if it shows it. Fire-and-forget, after the message is stored.
 */
import { isUserBlocked } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { publishUserEvent } from '@/lib/bots/events';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { MAX_MENTIONS, type StoredMention } from '@/lib/mentions';

export const MENTION_EVENT = 'mention';

export function notifyMentionedMembers(input: {
  serverId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  mentions: readonly StoredMention[];
}): void {
  const targets = [...new Set(input.mentions.map((mention) => mention.userId))]
    .filter((userId) => userId !== input.authorId)
    .slice(0, MAX_MENTIONS);
  for (const userId of targets) {
    void Promise.resolve()
      .then(async () => {
        const access = await authorizeChannelMessageAccess({
          userId,
          serverId: input.serverId,
          channelId: input.channelId,
          operation: 'read',
        });
        if (!access.ok) return;
        if (await isUserBlocked(getDb(), userId, input.authorId)) return;
        await publishUserEvent(userId, {
          type: MENTION_EVENT,
          serverId: input.serverId,
          channelId: input.channelId,
          messageId: input.messageId,
          fromUserId: input.authorId,
        });
      })
      .catch((err: Error) => {
        console.warn(`[mention-notify] failed: ${err.message}`);
      });
  }
}
