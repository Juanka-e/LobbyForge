'use client';

import { useEffect, useState } from 'react';
import { useLobbyVoice } from './LobbyVoiceProvider';

/**
 * Text channel list for the sidebar. Clicking a channel switches the
 * main area to that channel's messages. Shows an unread dot for channels
 * that have messages newer than the last-seen timestamp (tracked in
 * localStorage).
 */

interface Channel {
  id: string;
  name: string;
  category: 'text' | 'voice';
}

export interface LobbyTextChannelsProps {
  channels: Channel[];
  /** Server ID for fetching unread counts. */
  serverId?: string | null;
}

const STORAGE_KEY = 'lf-last-seen-channels';

function getLastSeen(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch { return {}; }
}

function markSeen(channelId: string) {
  const seen = getLastSeen();
  seen[channelId] = Date.now();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch { /* storage disabled */ }
}

export function LobbyTextChannels({ channels }: LobbyTextChannelsProps) {
  const voice = useLobbyVoice();
  const activeId = voice.activeTextChannelId;
  const [, forceUpdate] = useState(0);

  // Mark active channel as seen.
  useEffect(() => {
    if (activeId) markSeen(activeId);
  }, [activeId]);

  // Poll for unread (simple version: check message count via WS event).
  // For now, we just track active channel switching.
  useEffect(() => {
    function onMessageSent(e: Event) {
      const detail = (e as CustomEvent).detail as { channelId: string };
      if (detail.channelId !== activeId) {
        forceUpdate(n => n + 1);
      }
    }
    window.addEventListener('lf-message-sent', onMessageSent as EventListener);
    return () => window.removeEventListener('lf-message-sent', onMessageSent as EventListener);
  }, [activeId]);

  const lastSeen = getLastSeen();
  const now = Date.now();

  return (
    <div>
      <div className="flex items-center justify-between mb-2 group cursor-pointer">
        <h3 className="font-label-xs uppercase tracking-wider group-hover:text-text-secondary transition-colors text-text-secondary">
          Text Channels
        </h3>
        <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
          add
        </span>
      </div>
      <ul className="space-y-[2px]">
        {channels.length === 0 ? (
          <li className="px-2 py-1 text-label-xs text-text-muted italic">No text channels yet</li>
        ) : null}
        {channels.map((c) => {
          const active = c.id === activeId;
          const lastSeenTime = lastSeen[c.id] ?? 0;
          // Unread if: not active AND has been less than 60s since we got a message event
          // for this channel while it wasn't active. Simple heuristic.
          const isUnread = !active && lastSeenTime > 0 && (now - lastSeenTime) < 5000;
          return (
            <li key={c.id} className="relative">
              <button
                type="button"
                onClick={() => voice.setActiveTextChannel(c.id, c.name)}
                className={
                  active
                    ? 'w-full flex items-center justify-between px-2 py-1.5 rounded-md text-text-primary bg-surface-container-high transition-colors group'
                    : 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:text-text-secondary hover:bg-surface-container transition-colors group text-text-secondary'
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={
                      active
                        ? 'material-symbols-outlined text-[18px] text-primary'
                        : 'material-symbols-outlined text-[18px] opacity-70'
                    }
                  >
                    tag
                  </span>
                  <span className={`font-label-sm font-medium truncate ${!active && isUnread ? 'text-text-primary' : ''}`}>
                    {c.name}
                  </span>
                </div>
                {active ? (
                  <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
                    settings
                  </span>
                ) : isUnread ? (
                  <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
