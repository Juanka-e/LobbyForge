'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useLobbyVoice, type LobbyVoiceParticipant } from './LobbyVoiceProvider';
import Link from 'next/link';

/**
 * Voice channels list for the sidebar. Each voice channel is a button
 * that connects the user inline via `LobbyVoiceProvider.connectToChannel`.
 *
 * The active channel's roster reads from the LiveKit participants
 * (real speaking/mute indicators). Non-connected channels read from
 * a periodic server-wide presence poll (every 10s) so users see who
 * else is in voice across all channels, not just their own.
 */

interface Channel {
  id: string;
  name: string;
  category: 'text' | 'voice';
}

interface VoiceUser {
  id: string;
  name: string;
}

export interface LobbyVoiceChannelsProps {
  channels: Channel[];
  initialVoiceUsers?: VoiceUser[];
  initialVoiceUsersByChannel?: Record<string, VoiceUser[]>;
  initialActiveChannelId?: string | null;
  currentUserId: string | null;
}

interface PresenceEntry {
  userId: string;
  channelId: string;
  status?: string;
  lastSeen?: number;
}

const POLL_INTERVAL_MS = 10_000;

export function LobbyVoiceChannels({
  channels,
  initialVoiceUsers = [],
  initialVoiceUsersByChannel = {},
  initialActiveChannelId = null,
  currentUserId,
}: LobbyVoiceChannelsProps) {
  const voice = useLobbyVoice();
  const connectedId = voice.activeChannelId;
  const voiceChannelIdsRef = useRef(new Set(channels.map((c) => c.id)));
  voiceChannelIdsRef.current = new Set(channels.map((c) => c.id));

  // Name cache: userId → displayName. Seeded from SSR, updated by polls.
  const [nameCache, setNameCache] = useState<Record<string, string>>(() => {
    const cache: Record<string, string> = {};
    if (currentUserId) cache[currentUserId] = 'You';
    for (const users of Object.values(initialVoiceUsersByChannel)) {
      for (const u of users) cache[u.id] = u.name;
    }
    for (const u of initialVoiceUsers) cache[u.id] = u.name;
    return cache;
  });

  // Polled presence: channelId → userIds (only for voice channels).
  const [polledVoiceUsers, setPolledVoiceUsers] = useState<Record<string, string[]>>(
    () => {
      const map: Record<string, string[]> = {};
      for (const [chId, users] of Object.entries(initialVoiceUsersByChannel)) {
        if (voiceChannelIdsRef.current.has(chId)) {
          map[chId] = users.map((u) => u.id);
        }
      }
      if (initialActiveChannelId && initialVoiceUsers.length > 0) {
        map[initialActiveChannelId] = initialVoiceUsers.map((u) => u.id);
      }
      return map;
    }
  );

  const refreshPresence = useCallback(async () => {
    try {
      const res = await fetch(`/api/presence?serverId=${encodeURIComponent(voice.serverId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { presences?: PresenceEntry[] };
      if (!data.presences) return;

      const byChannel: Record<string, string[]> = {};
      for (const p of data.presences) {
        if (p.channelId && voiceChannelIdsRef.current.has(p.channelId)) {
          if (!byChannel[p.channelId]) byChannel[p.channelId] = [];
          byChannel[p.channelId].push(p.userId);
        }
      }
      setPolledVoiceUsers(byChannel);
    } catch {
      // Network hiccup — next poll retries.
    }
  }, [voice.serverId]);

  useEffect(() => {
    void refreshPresence();
    const id = window.setInterval(refreshPresence, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshPresence]);

  // Merge polled names into the cache whenever participants update.
  useEffect(() => {
    setNameCache((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of voice.participants) {
        if (p.identity && !next[p.identity]) {
          next[p.identity] = p.name;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [voice.participants]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 group cursor-pointer">
        <h3 className="font-label-xs uppercase tracking-wider group-hover:text-text-secondary transition-colors text-text-secondary">
          Voice Channels
        </h3>
        <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
          add
        </span>
      </div>
      <ul className="space-y-[2px]">
        {channels.length === 0 ? (
          <li className="px-2 py-1 text-label-xs text-text-muted italic">
            No voice channels yet
          </li>
        ) : null}
        {channels.map((c) => {
          const isConnected = c.id === connectedId;
          const isConnecting = c.id === voice.activeChannelId && voice.connecting;

          // For the connected channel: use LiveKit participants (real-time).
          // For other channels: use polled presence data.
          let participants: LobbyVoiceParticipant[];
          if (isConnected) {
            participants = voice.participants;
          } else {
            const userIds = polledVoiceUsers[c.id] ?? [];
            participants = userIds.map((uid) => ({
              id: uid,
              identity: uid,
              name: nameCache[uid] ?? 'User',
              isLocal: uid === currentUserId,
              isSpeaking: false,
              micEnabled: true,
              cameraEnabled: false,
              hasScreenShare: false,
            }));
          }

          return (
            <li key={c.id}>
              <div
                className={
                  isConnected
                    ? 'w-full flex items-center justify-between rounded-md text-text-primary bg-surface-container-high transition-colors group'
                    : 'w-full flex items-center justify-between rounded-md hover:text-text-secondary hover:bg-surface-container transition-colors group text-text-secondary'
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isConnected) {
                      voice.setMainViewMode('voice');
                    } else {
                      void voice.connectToChannel(c.id);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                >
                  <span
                    className={
                      isConnected
                        ? 'material-symbols-outlined text-[18px] text-primary'
                        : 'material-symbols-outlined text-[18px] opacity-70'
                    }
                  >
                    volume_up
                  </span>
                  <span className="font-label-sm font-medium truncate">{c.name}</span>
                  {isConnecting ? (
                    <span className="text-[10px] uppercase tracking-wider text-text-muted ml-1">
                      connecting…
                    </span>
                  ) : null}
                  {!isConnected && participants.length > 0 ? (
                    <span className="text-[10px] text-text-muted ml-1">
                      {participants.length} in voice
                    </span>
                  ) : null}
                </button>
                {isConnected ? (
                  <button
                    type="button"
                    onClick={() => voice.setMainViewMode('voice')}
                    className="grid size-7 flex-none place-items-center rounded text-primary hover:bg-surface-raised"
                    title="Open voice view"
                    aria-label={`Open ${c.name} voice view`}
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden>video_call</span>
                  </button>
                ) : null}
                <Link
                  href="/admin/settings/channels"
                  className="mr-1 grid size-7 flex-none place-items-center rounded text-text-secondary opacity-0 transition-opacity hover:bg-surface-raised hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
                  title="Channel settings"
                  aria-label={`Settings for ${c.name}`}
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden>settings</span>
                </Link>
              </div>
              {participants.length > 0 ? (
                <ul className="ml-6 mt-1 space-y-1 pb-2">
                  {participants.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-surface-container/50 cursor-pointer group"
                    >
                      <div
                        className={
                          u.isSpeaking
                            ? 'w-6 h-6 rounded-full bg-secondary-container relative border-2 border-success is-speaking'
                            : 'w-6 h-6 rounded-full bg-secondary-container relative border-2 border-transparent'
                        }
                      >
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-text-primary">
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span
                        className={
                          u.isSpeaking
                            ? 'font-label-sm text-text-primary flex-1 truncate'
                            : 'font-label-sm text-text-secondary flex-1 truncate'
                        }
                      >
                        {u.name}
                      </span>
                      {!u.micEnabled ? (
                        <span className="material-symbols-outlined text-[14px] text-danger">
                          mic_off
                        </span>
                      ) : null}
                      {u.cameraEnabled ? (
                        <span className="material-symbols-outlined text-[14px] text-primary" title="Camera on" aria-label="Camera on">videocam</span>
                      ) : null}
                      {u.hasScreenShare ? (
                        <span className="material-symbols-outlined text-[14px] text-success" title="Sharing screen" aria-label="Sharing screen">present_to_all</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

