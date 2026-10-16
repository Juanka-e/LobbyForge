'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { getRealtimeClient } from '@/lib/realtime-client';
import { useLobbyVoice } from './LobbyVoiceProvider';

interface DmChannelSummary {
  id: string;
  otherUserId: string;
  otherUserDisplayName: string;
  otherUserAvatarUrl: string | null;
  lastMessageAt: string;
  /** The newest message is the other participant's. */
  lastMessageFromOther?: boolean;
}

/** Rows the sidebar shows; the newest conversations first. */
const MAX_ROWS = 8;
/** A burst of messages re-reads the list once. */
const REFRESH_COALESCE_MS = 400;

function parseDmActivity(data: unknown): { channelId: string; fromUserId: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const { type, channelId, fromUserId } = data as { type?: unknown; channelId?: unknown; fromUserId?: unknown };
  if (type !== 'dm_activity' || typeof channelId !== 'string') return null;
  return { channelId, fromUserId: typeof fromUserId === 'string' ? fromUserId : null };
}

/**
 * The user's conversations, in the lobby sidebar.
 *
 * design pass: these were links to /dm/<id>, a full-page view that
 * replaced the whole app. They now open the conversation in the centre
 * column, so the channel list, roster and voice controls stay put — and
 * the row shows which conversation is open, like a channel does.
 *
 * docs/PROFILES.md "Live updates": the list follows the account's own feed
 * (`user:{uid}`). A message in any conversation re-reads it, so one somebody
 * else started appears at once, and a conversation that is not open gets an
 * unread mark until it is opened. Opening a new conversation from a profile
 * card re-reads it too.
 *
 * The mark does not depend on catching the event: every read after the
 * first compares with the one before, so a conversation that moved while
 * the feed was not live yet (just after the page rendered) or the socket
 * was down (a laptop asleep), with the other person's message newest, is
 * marked as well.
 */
export default function DmLinkSection({ currentUserId }: { currentUserId: string | null }) {
  const t = useT();
  const voice = useLobbyVoice();
  const [channels, setChannels] = useState<DmChannelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const openChannelId = voice.mainViewMode === 'dm' ? (voice.activeDm?.channelId ?? null) : null;
  const openChannelRef = useRef(openChannelId);
  openChannelRef.current = openChannelId;

  /** Each conversation's newest message time at the previous read; null before the first. */
  const lastRead = useRef<Map<string, number> | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch('/api/dm', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { channels?: DmChannelSummary[] };
      if (signal?.cancelled) return;
      const list = data.channels ?? [];
      const previous = lastRead.current;
      lastRead.current = new Map(list.map((channel) => [channel.id, Date.parse(channel.lastMessageAt)]));
      if (previous) {
        const moved = list.filter(
          (channel) =>
            channel.lastMessageFromOther === true &&
            channel.id !== openChannelRef.current &&
            Date.parse(channel.lastMessageAt) > (previous.get(channel.id) ?? Number.NEGATIVE_INFINITY)
        );
        if (moved.length > 0) {
          setUnread((current) => {
            const next = new Set(current);
            for (const channel of moved) next.add(channel.id);
            return next;
          });
        }
      }
      setChannels(list);
    } catch {
      // The next event or reconnect reads again.
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [currentUserId, load]);

  // A conversation opened from somewhere else (a profile card's "Message
  // @name", a /dm link) that the list does not know yet: read it again.
  const knownIds = useRef(new Set<string>());
  knownIds.current = new Set(channels.map((channel) => channel.id));
  useEffect(() => {
    if (!currentUserId || !openChannelId || knownIds.current.has(openChannelId)) return;
    void load();
  }, [currentUserId, openChannelId, load]);

  // Opening a conversation reads it.
  useEffect(() => {
    if (!openChannelId) return;
    setUnread((current) => {
      if (!current.has(openChannelId)) return current;
      const next = new Set(current);
      next.delete(openChannelId);
      return next;
    });
  }, [openChannelId]);

  useEffect(() => {
    if (!currentUserId) return;
    const client = getRealtimeClient();
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, REFRESH_COALESCE_MS);
    };
    const unsubscribe = client.subscribe(
      `user:${currentUserId}`,
      (data) => {
        const event = parseDmActivity(data);
        if (!event) return;
        if (event.fromUserId && event.fromUserId !== currentUserId && event.channelId !== openChannelRef.current) {
          setUnread((current) => (current.has(event.channelId) ? current : new Set(current).add(event.channelId)));
        }
        schedule();
      },
      // Live (first, or after a reconnect): a conversation started before
      // then was never announced here — read the list again.
      { onLive: schedule }
    );
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [currentUserId, load]);

  if (!currentUserId) return null;

  return (
    <div className="pt-2 mt-1 border-t border-border-subtle/50">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted font-semibold">
        <span className="material-symbols-outlined text-[14px]" aria-hidden>forum</span>
        {t('lobby.dm.title')}
      </div>
      {loading ? null : channels.length === 0 ? (
        <p className="px-2 py-1 text-xs text-text-muted">{t('lobby.dm.empty')}</p>
      ) : (
        <div className="space-y-0.5">
          {channels.slice(0, MAX_ROWS).map((ch) => {
            const active = openChannelId === ch.id;
            const isUnread = !active && unread.has(ch.id);
            return (
              <button
                key={ch.id}
                type="button"
                data-mobile-nav-close
                data-dm-row={ch.id}
                data-unread={isUnread || undefined}
                aria-current={active ? 'page' : undefined}
                onClick={() =>
                  voice.openDm({
                    channelId: ch.id,
                    name: ch.otherUserDisplayName,
                    avatarUrl: ch.otherUserAvatarUrl,
                    otherUserId: ch.otherUserId,
                  })
                }
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  active
                    ? 'bg-surface-container text-text-primary'
                    : isUnread
                      ? 'font-semibold text-text-primary hover:bg-surface-container'
                      : 'text-text-secondary hover:bg-surface-container hover:text-text-primary'
                }`}
              >
                <div className="w-5 h-5 rounded-full bg-secondary-container flex items-center justify-center text-[10px] font-bold text-text-primary flex-shrink-0 overflow-hidden">
                  {ch.otherUserAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user avatar, may be a data URL
                    <img src={ch.otherUserAvatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    initialOf(ch.otherUserDisplayName, { locale: t.locale })
                  )}
                </div>
                <span className="min-w-0 flex-1 truncate">{ch.otherUserDisplayName}</span>
                {isUnread ? (
                  <span className="flex-none size-2 rounded-full bg-primary" data-testid="dm-unread-dot">
                    <span className="sr-only">{t('lobby.dm.unread')}</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
