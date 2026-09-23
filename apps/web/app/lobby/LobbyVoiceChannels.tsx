'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useT } from '@/lib/i18n/client';
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
  /** MUTE_MEMBERS: show the moderator server-mute control on participants. */
  canMuteMembers?: boolean;
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
  canMuteMembers = false,
}: LobbyVoiceChannelsProps) {
  const t = useT();
  const voice = useLobbyVoice();
  const [moderationError, setModerationError] = useState<string | null>(null);
  const [pendingMute, setPendingMute] = useState<string | null>(null);

  // beta-review: moderator server mute from the voice roster (the API
  // existed but had no UI). The server persists it and enforces it in
  // LiveKit; the roster icon updates from the participant's permissions.
  const setServerMute = useCallback(
    async (channelId: string, userId: string, muted: boolean) => {
      setPendingMute(userId);
      setModerationError(null);
      try {
        const res = await fetch(
          `/api/servers/${voice.serverId}/channels/${channelId}/members/${userId}/voice/mute`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted }),
          }
        );
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          setModerationError(
            detail.error ?? t('lobbyMain.voice.muteFailedStatus', { status: res.status })
          );
        }
      } catch {
        setModerationError(t('lobbyMain.voice.muteFailed'));
      } finally {
        setPendingMute(null);
      }
    },
    [t, voice.serverId]
  );
  const connectedId = voice.activeChannelId;
  const voiceChannelIdsRef = useRef(new Set(channels.map((c) => c.id)));
  voiceChannelIdsRef.current = new Set(channels.map((c) => c.id));

  // Name cache: userId → displayName. Seeded from SSR, updated by polls.
  const [nameCache, setNameCache] = useState<Record<string, string>>(() => {
    const cache: Record<string, string> = {};
    if (currentUserId) cache[currentUserId] = t('lobbyMain.chat.you');
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
          {t('lobbyMain.voice.heading')}
        </h3>
        <span className="material-symbols-outlined text-[16px] opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">
          add
        </span>
      </div>
      <ul className="space-y-[2px]">
        {channels.length === 0 ? (
          <li className="px-2 py-1 text-label-xs text-text-muted italic">
            {t('lobbyMain.voice.empty')}
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
              name: nameCache[uid] ?? t('lobbyMain.chat.unknownUser'),
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
                      {t('lobbyMain.voice.connecting')}
                    </span>
                  ) : null}
                  {!isConnected && participants.length > 0 ? (
                    <span className="text-[10px] text-text-muted ml-1">
                      {t('lobbyMain.voice.inVoice', { count: participants.length })}
                    </span>
                  ) : null}
                </button>
                {isConnected ? (
                  <button
                    type="button"
                    onClick={() => voice.setMainViewMode('voice')}
                    className="grid size-7 flex-none place-items-center rounded text-primary hover:bg-surface-raised"
                    title={t('lobbyMain.voice.openTitle')}
                    aria-label={t('lobbyMain.voice.openLabel', { name: c.name })}
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden>video_call</span>
                  </button>
                ) : null}
                <Link
                  href="/admin/settings/channels"
                  className="mr-1 grid size-7 flex-none place-items-center rounded text-text-secondary opacity-0 transition-opacity hover:bg-surface-raised hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
                  title={t('lobbyMain.voice.settingsTitle')}
                  aria-label={t('lobbyMain.voice.settingsLabel', { name: c.name })}
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
                      {u.serverMuted ? (
                        <span
                          className="material-symbols-outlined text-[14px] text-danger"
                          title={t('lobbyMain.voice.serverMuted')}
                          aria-label={t('lobbyMain.voice.serverMuted')}
                        >
                          block
                        </span>
                      ) : !u.micEnabled ? (
                        <span className="material-symbols-outlined text-[14px] text-danger">
                          mic_off
                        </span>
                      ) : null}
                      {isConnected && canMuteMembers && !u.isLocal ? (
                        <button
                          type="button"
                          disabled={pendingMute === u.identity}
                          onClick={(event) => {
                            event.stopPropagation();
                            void setServerMute(c.id, u.identity, !u.serverMuted);
                          }}
                          title={
                            u.serverMuted
                              ? t('lobbyMain.voice.serverUnmute', { name: u.name })
                              : t('lobbyMain.voice.serverMute', { name: u.name })
                          }
                          aria-label={
                            u.serverMuted
                              ? t('lobbyMain.voice.serverUnmute', { name: u.name })
                              : t('lobbyMain.voice.serverMute', { name: u.name })
                          }
                          className="grid size-5 place-items-center rounded text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
                        >
                          <span className="material-symbols-outlined text-[14px]" aria-hidden>
                            {u.serverMuted ? 'mic' : 'mic_off'}
                          </span>
                        </button>
                      ) : null}
                      {u.cameraEnabled ? (
                        <span className="material-symbols-outlined text-[14px] text-primary" title={t('lobbyMain.voice.cameraOn')} aria-label={t('lobbyMain.voice.cameraOn')}>videocam</span>
                      ) : null}
                      {u.hasScreenShare ? (
                        <span className="material-symbols-outlined text-[14px] text-success" title={t('lobbyMain.voice.sharingScreen')} aria-label={t('lobbyMain.voice.sharingScreen')}>present_to_all</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {moderationError ? (
        <p className="px-2 pt-1 text-[11px] text-danger" role="alert">
          {moderationError}
        </p>
      ) : null}
    </div>
  );
}

