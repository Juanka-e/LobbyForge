'use client';

import { useEffect } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { parseUserEvent } from '@/lib/bots/client-api';
import { interactionStore } from '@/lib/bots/interaction-store';

/**
 * Listens on the signed-in user's own gateway topic, `user:{uid}` (the
 * gateway authorises it for that uid's session only), and feeds ephemeral
 * answers and interaction status into the interaction store. Mounted once
 * per lobby so an answer that arrives while a DM is open still shows when
 * the member returns to the channel.
 */
export function useUserInteractionFeed(currentUserId: string | null): void {
  useEffect(() => {
    if (!currentUserId) return;
    const client = getRealtimeClient();
    return client.subscribe(`user:${currentUserId}`, (data) => {
      const event = parseUserEvent(data);
      if (!event) return;
      if (event.kind === 'ephemeral') {
        interactionStore.addEphemeral({
          key: event.key,
          interactionId: event.interactionId,
          serverId: event.serverId,
          channelId: event.channelId,
          botName: event.bot?.name ?? null,
          commandName: event.commandName,
          content: event.content,
          createdAt: event.createdAt,
        });
        return;
      }
      if (event.status === 'answered') interactionStore.markAnswered(event.interactionId);
      else interactionStore.markExpired(event.interactionId, event.status);
    });
  }, [currentUserId]);
}
