'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { getRealtimeClient } from '@/lib/realtime-client';
import { isInVoiceRoom } from '@/lib/voice-connection';
import {
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  playNotificationSound,
  shouldNotify,
  type NotificationPrefs,
} from '@/lib/notification-prefs';
import { useLobbyVoice } from './LobbyVoiceProvider';
import { useProfileCard } from './ProfileCardProvider';

/**
 * Text channel list for the sidebar. Clicking a channel switches the
 * main area to that channel's messages.
 *
 * docs/PROFILES.md "Mentions": a message elsewhere in this community that
 * names the viewer arrives on their own feed (`user:{uid}`, type `mention`;
 * the server sends it only to members who may read that channel). The
 * channel gets a red badge with the count until it is opened ("Unread
 * badge" in Settings → Notifications), and a hidden tab gets a desktop
 * notification. The open channel's own messages are the chat's job.
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
  /**
   * The channel settings page, for a viewer it will open for (Manage
   * Channels). Without it the list shows no settings or add hints.
   */
  channelSettingsHref?: string | null;
}

interface MentionEvent {
  serverId: string;
  channelId: string;
  fromUserId: string | null;
}

function parseMention(data: unknown): MentionEvent | null {
  if (!data || typeof data !== 'object') return null;
  const { type, serverId, channelId, fromUserId } = data as Record<string, unknown>;
  if (type !== 'mention' || typeof serverId !== 'string' || typeof channelId !== 'string') return null;
  return { serverId, channelId, fromUserId: typeof fromUserId === 'string' ? fromUserId : null };
}

/** The badge stops counting here ("9+"). */
const MAX_BADGE = 9;

export function LobbyTextChannels({ channels, channelSettingsHref = null }: LobbyTextChannelsProps) {
  const canManageChannels = Boolean(channelSettingsHref);
  const t = useT();
  const voice = useLobbyVoice();
  const profile = useProfileCard();
  const activeId = voice.activeTextChannelId;
  const serverId = voice.serverId;
  const currentUserId = profile?.currentUserId ?? null;
  const [mentions, setMentions] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  // Read in the event handler without resubscribing on every change.
  const latest = useRef({ activeId, channels, prefs, inVoice: false, profile });
  latest.current = {
    activeId,
    channels,
    prefs,
    inVoice: Boolean(voice.activeChannelId) && isInVoiceRoom(voice.connectionState),
    profile,
  };

  useEffect(() => {
    let cancelled = false;
    void loadNotificationPrefs().then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opening a channel reads its mentions.
  useEffect(() => {
    if (!activeId) return;
    setMentions((current) => {
      if (!current.has(activeId)) return current;
      const next = new Map(current);
      next.delete(activeId);
      return next;
    });
  }, [activeId]);

  useEffect(() => {
    if (!currentUserId || !serverId) return;
    const client = getRealtimeClient();
    return client.subscribe(`user:${currentUserId}`, (data) => {
      const event = parseMention(data);
      if (!event || event.serverId !== serverId) return;
      const now = latest.current;
      // The open channel shows (and notifies about) its own messages.
      if (event.channelId === now.activeId) return;
      const channel = now.channels.find((c) => c.id === event.channelId);
      if (!channel) return;
      setMentions((current) => new Map(current).set(event.channelId, (current.get(event.channelId) ?? 0) + 1));
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        shouldNotify(now.prefs, { mentioned: true, inVoice: now.inVoice, hidden: document.visibilityState !== 'visible' })
      ) {
        const author =
          (event.fromUserId ? now.profile?.seedFor(event.fromUserId)?.displayName : null) ?? t('lobbyMain.chat.unknownUser');
        new Notification(t('lobbyMain.text.mentionNotificationTitle', { author, channel: channel.name }), {
          body: t('lobbyMain.text.mentionNotificationBody'),
          silent: true,
          tag: `lf-mention:${event.channelId}`,
        });
        playNotificationSound(now.prefs.sound);
      }
    });
  }, [currentUserId, serverId, t]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 group cursor-pointer">
        <h3 className="font-label-xs uppercase tracking-wider group-hover:text-text-secondary transition-colors text-text-secondary">
          {t('lobbyMain.text.heading')}
        </h3>
        {/* Hints that channels can be added or configured — only for those who can. */}
        {canManageChannels ? (
          <span
            className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary"
            aria-hidden
          >
            add
          </span>
        ) : null}
      </div>
      <ul className="space-y-[2px]">
        {channels.length === 0 ? (
          <li className="px-2 py-1 text-label-xs text-text-muted italic">{t('lobbyMain.text.empty')}</li>
        ) : null}
        {channels.map((c) => {
          const active = c.id === activeId;
          const mentionCount = !active && prefs.unreadBadge ? (mentions.get(c.id) ?? 0) : 0;
          return (
            <li key={c.id} className="relative">
              <button
                type="button"
                data-mobile-nav-close
                data-mentions={mentionCount || undefined}
                aria-current={active ? 'page' : undefined}
                onClick={() => voice.setActiveTextChannel(c.id, c.name)}
                className={
                  active
                    ? 'w-full flex items-center justify-between px-2 py-1.5 rounded-md text-text-primary bg-surface-container-high transition-colors group'
                    : `w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:text-text-secondary hover:bg-surface-container transition-colors group ${
                        mentionCount ? 'text-text-primary' : 'text-text-secondary'
                      }`
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={
                      active
                        ? 'material-symbols-outlined text-[18px] text-primary'
                        : 'material-symbols-outlined text-[18px] opacity-70'
                    }
                    aria-hidden
                  >
                    tag
                  </span>
                  <span className={`font-label-sm truncate ${mentionCount ? 'font-semibold' : 'font-medium'}`}>
                    {c.name}
                  </span>
                </div>
                {active && canManageChannels ? (
                  <span
                    className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary"
                    aria-hidden
                  >
                    settings
                  </span>
                ) : mentionCount ? (
                  <span
                    className="grid min-w-[18px] h-[18px] flex-none place-items-center rounded-full bg-danger px-1 text-[11px] font-bold leading-none text-background"
                    data-testid="channel-mention-badge"
                  >
                    <span aria-hidden>{mentionCount > MAX_BADGE ? `${MAX_BADGE}+` : mentionCount}</span>
                    <span className="sr-only">{t('lobbyMain.text.mentionCount', { count: mentionCount })}</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
