'use client';

import { useEffect, useState } from 'react';

interface DmChannelSummary {
  id: string;
  otherUserId: string;
  otherUserDisplayName: string;
  otherUserAvatarUrl: string | null;
  lastMessageAt: string;
}

/**
 * Shows the user's DM channels in the lobby sidebar (official instance).
 * Fetches from GET /api/dm and renders clickable links to /dm/{id}.
 */
export default function DmLinkSection({ currentUserId }: { currentUserId: string | null }) {
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
        Direct Messages
      </div>
      {loading ? null : channels.length === 0 ? (
        <p className="px-2 py-1 text-xs text-text-muted">No conversations yet</p>
      ) : (
        <div className="space-y-0.5">
          {channels.slice(0, 8).map((ch) => (
            <a
              key={ch.id}
              href={`/dm/${ch.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors group"
            >
              <div className="w-5 h-5 rounded-full bg-secondary-container flex items-center justify-center text-[10px] font-bold text-text-primary flex-shrink-0 overflow-hidden">
                {ch.otherUserAvatarUrl ? (
                  <img src={ch.otherUserAvatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  ch.otherUserDisplayName.charAt(0).toUpperCase()
                )}
              </div>
              <span className="truncate">{ch.otherUserDisplayName}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
