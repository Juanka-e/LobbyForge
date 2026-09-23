'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { useLobbyVoice } from './LobbyVoiceProvider';

interface DmChannelSummary {
  id: string;
  otherUserId: string;
  otherUserDisplayName: string;
  otherUserAvatarUrl: string | null;
  lastMessageAt: string;
}

/**
 * The user's conversations, in the lobby sidebar.
 *
 * design pass: these were links to /dm/<id>, a full-page view that
 * replaced the whole app. They now open the conversation in the centre
 * column, so the channel list, roster and voice controls stay put — and
 * the row shows which conversation is open, like a channel does.
 */
export default function DmLinkSection({ currentUserId }: { currentUserId: string | null }) {
  const t = useT();
  const voice = useLobbyVoice();
  const [channels, setChannels] = useState<DmChannelSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/dm', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setChannels(data.channels ?? []);
      } catch {
        // swallow
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [currentUserId]);

  if (!currentUserId) return null;

  return (
    <div className="pt-2 mt-1 border-t border-border-subtle/50">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted font-semibold">
        <span className="material-symbols-outlined text-[14px]">forum</span>
        {t('lobby.dm.title')}
      </div>
      {loading ? null : channels.length === 0 ? (
        <p className="px-2 py-1 text-xs text-text-muted">{t('lobby.dm.empty')}</p>
      ) : (
        <div className="space-y-0.5">
          {channels.slice(0, 8).map((ch) => {
            const active = voice.mainViewMode === 'dm' && voice.activeDm?.channelId === ch.id;
            return (
              <button
                key={ch.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() =>
                  voice.openDm({
                    channelId: ch.id,
                    name: ch.otherUserDisplayName,
                    avatarUrl: ch.otherUserAvatarUrl,
                  })
                }
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  active
                    ? 'bg-surface-container text-text-primary'
                    : 'text-text-secondary hover:bg-surface-container hover:text-text-primary'
                }`}
              >
                <div className="w-5 h-5 rounded-full bg-secondary-container flex items-center justify-center text-[10px] font-bold text-text-primary flex-shrink-0 overflow-hidden">
                  {ch.otherUserAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user avatar, may be a data URL
                    <img src={ch.otherUserAvatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    ch.otherUserDisplayName.charAt(0).toUpperCase()
                  )}
                </div>
                <span className="truncate">{ch.otherUserDisplayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
