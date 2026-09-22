/**
 * Voice-room UI.
 *
 * Flow (mirrors the M9 connect page but actually connects):
 *   1. Mount → if no session, POST /api/auth/guest.
 *   2. POST /api/livekit/token with serverId + channelId -> get a JWT.
 *   3. new Room({ adaptiveStream, dynacast }).connect(WS_URL, JWT).
 *   4. Render the local + remote participant list and attach remote
 *      audio. Mic toggle uses `localParticipant.setMicrophoneEnabled`;
 *      deafen disables the remote audio publications (server stops
 *      sending) and also covers publications that appear later.
 *   5. If `serverId` + `channelId` query params are present, post a
 *      presence heartbeat every 5s to POST /api/presence.
 *
 * M14 scope is self-mute/deafen only. Server-side mute (M15) needs
 * `livekit-server-sdk` and a `RoomServiceClient.muteParticipant` call.
 *
 * The LiveKit URL comes from the token response (resolved at request time
 * on the server), then the build-time `NEXT_PUBLIC_LIVEKIT_URL`, then the
 * same-origin `/livekit` proxy. The JWT never carries the API secret.
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  type LocalParticipant,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { resolveBrowserLiveKitUrl } from '@/lib/public-endpoints';
import { getPlugin } from '@/lib/plugin-registry';
import { getRealtimeClient } from '@/lib/realtime-client';
import { PluginSurface } from '../PluginSurface';

type Guest = { gid: string; uid: string | null; name: string };
type Token = {
  token: string;
  identity: string;
  room: string;
  expiresAt: number;
  /** Runtime LiveKit URL (null → same-origin /livekit). */
  livekitUrl?: string | null;
  // VOICE-001: per-user ephemeral TURN credentials (coturn REST auth).
  iceServers?: RTCIceServer[];
};
type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; message: string };

const HEARTBEAT_INTERVAL_MS = 5_000;
const PRESENCE_TTL_SECONDS = 90;

type ParticipantUiMetadata = {
  kind?: string;
  bot?: boolean;
  botType?: string;
  trustLevel?: string;
  publisher?: string;
};

function parseParticipantMetadata(raw: string | undefined): ParticipantUiMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ParticipantUiMetadata;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isBotParticipant(participant: Participant): boolean {
  const metadata = parseParticipantMetadata(participant.metadata);
  return metadata.bot === true || metadata.kind === 'bot' || participant.identity.startsWith('bot:');
}

function RoomView({ roomName }: { roomName: string }) {
  const search = useSearchParams();
  const serverId = search?.get('serverId') ?? null;
  const channelId = search?.get('channelId') ?? null;
  const buildTimeLivekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  const [guest, setGuest] = useState<Guest | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [roomState, setRoomState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const roomRef = useRef<Room | null>(null);
  // beta-review: this page used to never attach remote audio — Hushle
  // players heard nobody. Remote audio elements live in a hidden container.
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const deafenedRef = useRef(false);
  deafenedRef.current = deafened;
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1. Ensure a guest session exists.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus({ kind: 'busy' });
      try {
        // Try a re-bind first so a returning visitor keeps their gid.
        const probe = await fetch('/api/auth/guest', { method: 'GET', credentials: 'same-origin' });
        if (probe.ok) {
          const data = (await probe.json()) as { guest: Guest };
          if (!cancelled) {
            setGuest(data.guest);
            setStatus({ kind: 'idle' });
          }
          return;
        }
        const res = await fetch('/api/auth/guest', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`POST /api/auth/guest → ${res.status}`);
        const data = (await res.json()) as { guest: Guest };
        if (!cancelled) {
          setGuest(data.guest);
          setStatus({ kind: 'idle' });
        }
      } catch (err) {
        if (!cancelled) setStatus({ kind: 'error', message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const collectParticipants = useCallback((room: Room) => {
    const list = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
    setParticipants(list);
  }, []);

  // 2. Connect once we have a guest.
  useEffect(() => {
    if (!guest) return;
    let cancelled = false;

    void (async () => {
      setStatus({ kind: 'busy' });
      try {
        if (!serverId || !channelId) {
          setStatus({ kind: 'error', message: 'Voice connection requires serverId and channelId.' });
          return;
        }
        const res = await fetch('/api/livekit/token', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, channelId }),
        });
        if (res.status === 401) {
          setStatus({ kind: 'error', message: 'Session expired — refresh the page.' });
          return;
        }
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(`POST /api/livekit/token → ${res.status} ${JSON.stringify(detail)}`);
        }
        const token = (await res.json()) as Token;

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
        });
        roomRef.current = room;

        room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          if (cancelled) return;
          setRoomState(state);
        });
        room.on(RoomEvent.ParticipantConnected, () => collectParticipants(room));
        room.on(RoomEvent.ParticipantDisconnected, () => collectParticipants(room));
        room.on(RoomEvent.ActiveSpeakersChanged, () => collectParticipants(room));
        room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
          if (track.kind !== Track.Kind.Audio) return;
          if (deafenedRef.current) publication.setEnabled(false);
          const element = track.attach();
          element.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
          audioContainerRef.current?.appendChild(element);
        });
        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          for (const element of track.detach()) element.remove();
        });
        room.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio));
        const syncMic = () => {
          const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          setMicEnabled(!!pub?.track && !pub.isMuted);
        };
        room.on(RoomEvent.LocalTrackPublished, syncMic);
        room.on(RoomEvent.LocalTrackUnpublished, syncMic);
        room.on(RoomEvent.TrackMuted, (_pub, participant) => { if (participant.isLocal) syncMic(); });
        room.on(RoomEvent.TrackUnmuted, (_pub, participant) => { if (participant.isLocal) syncMic(); });

        // VOICE-001: server-issued ephemeral TURN servers (ICE fallback).
        await room.connect(resolveBrowserLiveKitUrl(token.livekitUrl, buildTimeLivekitUrl), token.token, {
          ...(token.iceServers?.length
            ? { rtcConfig: { iceServers: token.iceServers } }
            : {}),
        });
        if (cancelled) {
          await room.disconnect();
          return;
        }
        collectParticipants(room);
        setAudioBlocked(!room.canPlaybackAudio);
        setStatus({ kind: 'ok', message: `Connected to ${token.room} as ${token.identity}` });
      } catch (err) {
        if (!cancelled) setStatus({ kind: 'error', message: (err as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      const r = roomRef.current;
      if (r) {
        void r.disconnect();
        roomRef.current = null;
      }
      if (audioContainerRef.current) audioContainerRef.current.replaceChildren();
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [guest, serverId, channelId, buildTimeLivekitUrl, collectParticipants]);

  // 2.5 Adopt an activity that is ALREADY running in this channel.
  //
  // beta-review: `activeSessionId` was only ever set by the local
  // "Start activity" click, so anyone who opened the room while a game
  // was in progress — including the host after a page reload — saw the
  // picker instead of the game, and pressing Start answered 409 with a
  // raw error blob. A channel holds at most one open activity, so the
  // room simply joins it.
  useEffect(() => {
    if (!serverId || !channelId) return;
    if (!guest?.uid) return;
    if (activeSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/activities`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          activities?: Array<{ id: string; status: string }>;
        };
        const open = data.activities?.find((a) => a.status !== 'ended' && a.status !== 'cancelled');
        if (open && !cancelled) setActiveSessionId(open.id);
      } catch {
        // Non-fatal: the picker stays available and a 409 there is
        // reported to the user rather than silently swallowed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, channelId, guest?.uid, activeSessionId]);

  // 3. Presence heartbeat — only if serverId + channelId are in the query string.
  useEffect(() => {
    if (!serverId || !channelId) return;
    if (!guest?.uid) return;

    const post = async () => {
      try {
        // beta-review: this used to POST to the channel presence route,
        // which is READ-only (GET) and answered 405 on every beat — so
        // nobody in a /room/ page was ever visible in the lobby roster.
        // `POST /api/presence` is the one presence write path.
        await fetch('/api/presence', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, channelId, status: 'online' }),
        });
      } catch {
        // Swallow — a single missed heartbeat is fine; the 90s TTL handles
        // long disconnects server-side.
      }
    };
    // Fire once immediately so the list reflects the joiner without waiting
    // a full interval.
    void post();
    heartbeatRef.current = setInterval(post, HEARTBEAT_INTERVAL_MS);
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [serverId, channelId, guest?.uid]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const next = !(pub?.track && !pub.isMuted);
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
    const after = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    setMicEnabled(!!after?.track && !after.isMuted);
  }, []);

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !deafened;
    deafenedRef.current = next;
    setDeafened(next);
    // Stop receiving remote audio (new publications are covered in the
    // TrackSubscribed handler via deafenedRef).
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) pub.setEnabled(!next);
    }
  }, [deafened]);

  const startAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.startAudio().catch(() => {});
    setAudioBlocked(!room.canPlaybackAudio);
  }, []);

  const localParticipant = roomRef.current?.localParticipant as LocalParticipant | undefined;

  const stateLabel = useMemo(() => {
    switch (roomState) {
      case ConnectionState.Connected:
        return 'connected';
      case ConnectionState.Connecting:
        return 'connecting…';
      case ConnectionState.Reconnecting:
        return 'reconnecting…';
      case ConnectionState.Disconnected:
        return 'disconnected';
      default:
        return roomState;
    }
  }, [roomState]);

  return (
    <section>
      <div ref={audioContainerRef} aria-hidden style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} />
      <h1 style={{ marginTop: 0 }}>Voice room: {roomName}</h1>
      <p style={{ color: '#9aa3ad' }}>
        Connection: <code>{stateLabel}</code> · {participants.length} participant
        {participants.length === 1 ? '' : 's'}
        {localParticipant ? ` · you are ${localParticipant.identity}` : ''}
        {serverId && channelId ? ` · presence posted to ${channelId}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={toggleMic} disabled={!roomRef.current}>
          {micEnabled ? 'Mute mic' : 'Unmute mic'}
        </button>
        <button onClick={toggleDeafen} disabled={!roomRef.current}>
          {deafened ? 'Undeafen' : 'Deafen'}
        </button>
        {audioBlocked ? (
          <button onClick={() => void startAudio()}>Enable audio</button>
        ) : null}
        <ActivityPicker
          serverId={serverId}
          channelId={channelId}
          activeSessionId={activeSessionId}
          onStart={(id) => setActiveSessionId(id)}
        />
      </div>

      <div
        style={{
          border: '1px solid #1f242c',
          borderRadius: 8,
          background: '#11151b',
          padding: 16,
          maxWidth: 640,
        }}
      >
        <strong>Participants</strong>
        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          {participants.map((p) => {
            const metadata = parseParticipantMetadata(p.metadata);
            const isBot = isBotParticipant(p);
            return (
              <li
                key={p.sid}
                title={
                  isBot
                    ? `${metadata.publisher ?? 'Unknown publisher'} - ${metadata.botType ?? 'bot'}`
                    : undefined
                }
              >
              {p.identity}
              {p === localParticipant ? ' (you)' : ''}
              {isBot ? (
                <>
                  {' '}
                  <span
                    style={{
                      border: '1px solid #3b82f6',
                      color: '#93c5fd',
                      borderRadius: 4,
                      padding: '1px 5px',
                      fontSize: 11,
                    }}
                  >
                    BOT
                  </span>
                  {metadata.trustLevel ? (
                    <span
                      style={{
                        marginLeft: 4,
                        color: metadata.trustLevel === 'official' ? '#5ad48a' : '#f5c542',
                        fontSize: 12,
                      }}
                    >
                      {metadata.trustLevel}
                    </span>
                  ) : null}
                </>
              ) : null}
              {' — '}
              {p.isSpeaking ? 'speaking' : 'silent'}
            </li>
            );
          })}
        </ul>
      </div>

      {activeSessionId && serverId && (
        <ActivityPanel
          serverId={serverId}
          sessionId={activeSessionId}
          actorUserId={guest?.uid ?? null}
          onEnd={() => setActiveSessionId(null)}
        />
      )}

      <StatusLine status={status} />
      <p style={{ color: '#9aa3ad', marginTop: 16, fontSize: 13 }}>
        Presence TTL is {PRESENCE_TTL_SECONDS}s. The UI posts every {HEARTBEAT_INTERVAL_MS / 1000}s.
        Server-side mute is M15.
      </p>
    </section>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  const color =
    status.kind === 'busy' ? '#9aa3ad' : status.kind === 'error' ? '#e36049' : '#5ad48a';
  return <p style={{ color, marginTop: 16 }}>{status.kind === 'busy' ? '…' : status.message}</p>;
}

type PluginCatalogMetadata = {
  category?: string;
  summary?: string;
  publisher?: string;
  trustLevel?: string;
  playerConfig?: {
    minPlayers?: number;
    maxPlayers?: number;
    defaultMaxPlayers?: number;
    supportsSpectators?: boolean;
    supportsQueue?: boolean;
    overflowPolicy?: string;
  };
  requiresVoiceRoom?: boolean;
  tags?: string[];
};

type PluginSummary = {
  id: string;
  name: string;
  version: string;
  type: string;
  catalog: PluginCatalogMetadata | null;
};

/**
 * "Start Activity" picker. Lists the plugins the registry knows about
 * (sourced from `GET /api/plugins`) and POSTs a start request to the
 * channel. Hidden when no `serverId`/`channelId` is in the URL — the
 * picker is meaningless in a room that isn't tied to a server channel.
 */
function ActivityPicker({
  serverId,
  channelId,
  activeSessionId,
  onStart,
}: {
  serverId: string | null;
  channelId: string | null;
  activeSessionId: string | null;
  onStart: (sessionId: string) => void;
}) {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId || !channelId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/apps`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`GET /api/servers/${serverId}/apps → ${res.status}`);
        const data = (await res.json()) as { apps: Array<PluginSummary & { installed: boolean; enabled: boolean }> };
        const enabledApps = data.apps.filter((app) => app.installed && app.enabled);
        if (!cancelled) {
          setPlugins(enabledApps);
          if (enabledApps[0]) setSelected(enabledApps[0].id);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, channelId]);

  if (!serverId || !channelId) return null;
  if (activeSessionId) return null;

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/servers/${serverId}/channels/${channelId}/activities`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId: selected }),
        }
      );
      if (res.status === 409) {
        // A channel holds one open activity. Someone else started one
        // between render and click — join it instead of showing the
        // raw conflict payload.
        const conflict = (await res.json().catch(() => ({}))) as { activity?: { id: string } };
        if (conflict.activity?.id) {
          onStart(conflict.activity.id);
          return;
        }
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${JSON.stringify(detail)}`);
      }
      const data = (await res.json()) as { activity: { id: string } };
      onStart(data.activity.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!plugins) {
    return <span style={{ color: '#9aa3ad' }}>Loading plugins…</span>;
  }
  if (plugins.length === 0) {
    return <span style={{ color: '#9aa3ad' }}>No enabled apps for this server.</span>;
  }
  const selectedPlugin = plugins.find((p) => p.id === selected) ?? null;
  const playerConfig = selectedPlugin?.catalog?.playerConfig;
  const playerRange =
    playerConfig?.minPlayers || playerConfig?.maxPlayers
      ? `${playerConfig.minPlayers ?? 1}-${playerConfig.maxPlayers ?? 'any'} players`
      : null;
  const trustLabel =
    selectedPlugin?.catalog?.trustLevel === 'official'
      ? 'Official'
      : selectedPlugin?.catalog?.trustLevel === 'verified-community'
        ? 'Verified'
        : selectedPlugin?.catalog?.trustLevel === 'unverified'
          ? 'Unverified'
          : null;

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        disabled={busy}
        style={{ padding: '4px 8px', background: '#11151b', color: '#e6e8eb', border: '1px solid #1f242c', borderRadius: 4 }}
      >
        {plugins.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button onClick={start} disabled={busy || !selected}>
        {busy ? 'Starting…' : 'Start activity'}
      </button>
      </span>
      {selectedPlugin && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: '#9aa3ad', fontSize: 12 }}>
          {trustLabel && (
            <span style={{ border: '1px solid #2f8f62', color: '#5ad48a', borderRadius: 4, padding: '1px 5px' }}>
              {trustLabel}
            </span>
          )}
          {playerRange && <span>{playerRange}</span>}
          {selectedPlugin.catalog?.summary && <span>{selectedPlugin.catalog.summary}</span>}
        </span>
      )}
      {error && <span style={{ color: '#e36049', fontSize: 13 }}>{error}</span>}
    </span>
  );
}

type ActivityDetail = {
  id: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  createdBy: string | null;
  players: Array<{ userId: string; name?: string | null; status: string; score: number }>;
};

/**
 * Activity panel. Polls the per-session endpoint every 2s and:
 *   - If the registered plugin exposes a `renderClient` (M17+), renders
 *     the plugin-specific UI. The plugin decides what to show for the
 *     current state; the host just wires dispatch + actor + host.
 *   - Otherwise falls back to the JSON panel + free-form action form
 *     (the M16 generic surface, kept for plugins that don't ship a UI).
 *
 * The host or any admin with `START_ACTIVITY` can end the session.
 */
function ActivityPanel({
  serverId,
  sessionId,
  actorUserId,
  onEnd,
}: {
  serverId: string;
  sessionId: string;
  actorUserId: string | null;
  onEnd: () => void;
}) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [actionJson, setActionJson] = useState<string>('{"type":"end"}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Card packs for the lobby pack picker. Plugins that ship built-in
  // content (e.g. Hushle) read from this list when starting a new game.
  // Fetched lazily — only while the activity is in lobby phase — so we
  // don't burn the rate limit on a deck the user already chose.
  const [cardPacks, setCardPacks] = useState<
    Array<{
      id: string;
      slug: string;
      name: string;
      language: string;
      cardCount: number;
      isBuiltIn: boolean;
    }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/servers/${serverId}/activities/${sessionId}`,
          { credentials: 'same-origin' }
        );
        if (res.status === 404) {
          // Session ended (probably from another tab). Clear local state.
          if (!cancelled) onEnd();
          return;
        }
        if (!res.ok) {
          throw new Error(`GET activity → ${res.status}`);
        }
        const data = (await res.json()) as { activity: ActivityDetail };
        if (!cancelled) setDetail(data.activity);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };

    // Primary path: WebSocket via the realtime-client (M20-bis). The
    // client subscribes to the per-session activity topic; the gateway
    // pushes `event` messages as other clients dispatch actions.
    let unsubscribe: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollFallback = false;

    const handleEvent = (data: unknown) => {
      if (cancelled) return;
      if (!data || typeof data !== 'object') return;
      const obj = data as { type?: string; status?: string; state?: Record<string, unknown>; id?: string; pluginId?: string; publicSummary?: Record<string, unknown>; createdBy?: string; players?: unknown; at?: string };
      if (obj.type === 'snapshot' || obj.id) {
        // snapshot event from the activity stream — full activity payload.
        if (!cancelled) {
          setDetail({
            id: obj.id ?? '',
            pluginId: obj.pluginId ?? '',
            status: obj.status ?? '',
            state: obj.state ?? {},
            createdBy: obj.createdBy ?? null,
            players: Array.isArray(obj.players)
              ? (obj.players as ActivityDetail['players'])
              : [],
          });
        }
      } else if (obj.status && obj.state) {
        // state event — patch the existing detail.
        if (!cancelled) {
          setDetail((prev) =>
            prev ? { ...prev, status: obj.status as string, state: obj.state as Record<string, unknown> } : prev
          );
        }
      }
    };

    // beta-review: ALWAYS fetch the current state once on mount. A
    // subscription only delivers FUTURE events, so on the WebSocket path
    // the panel used to sit on "…" until somebody dispatched an action —
    // a host who had just started an activity saw a dead panel and no
    // way to start the game.
    void fetchOnce();

    try {
      const client = getRealtimeClient();
      client.connect();
      unsubscribe = client.subscribe(
        `activity-state:${serverId}:${sessionId}` as const,
        handleEvent
      );
    } catch {
      pollFallback = true;
    }

    // `connect()` is asynchronous, so the socket is still CONNECTING right
    // here — checking readyState synchronously (the old behaviour) could
    // never detect a failure. Re-check shortly after, and keep watching:
    // if the socket is not OPEN we poll, and we stop polling once it is.
    const ensureTransport = () => {
      if (cancelled) return;
      let open = false;
      try {
        open = !pollFallback && getRealtimeClient().readyState === WebSocket.OPEN;
      } catch {
        open = false;
      }
      if (open) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }
      // 5s polling cadence — recovery lane when WS isn't available.
      if (!pollTimer) pollTimer = setInterval(fetchOnce, 5_000);
    };
    const transportTimer = setInterval(ensureTransport, 5_000);
    const transportDelay = setTimeout(ensureTransport, 1_500);

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
      clearTimeout(transportDelay);
      clearInterval(transportTimer);
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, [serverId, sessionId, onEnd]);

  // Fetch the card-pack list while we're in lobby phase. The plugin
  // panel uses this to populate its pack picker.
  useEffect(() => {
    if (!detail || (detail.state as { phase?: string })?.phase !== 'lobby') return;
    let cancelled = false;
    const loadPacks = async () => {
      try {
        const res = await fetch(
          `/api/servers/${serverId}/card-packs`,
          { credentials: 'same-origin' }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { cardPacks: typeof cardPacks };
        if (!cancelled) setCardPacks(data.cardPacks);
      } catch {
        // Soft failure — the panel falls back to the language-only form.
      }
    };
    void loadPacks();
    return () => {
      cancelled = true;
    };
  }, [serverId, detail]);

  const sendAction = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/servers/${serverId}/activities/${sessionId}/actions`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          // LF-002: every dispatch carries a fresh idempotency key; a
          // transport-level retry of THIS request reuses it server-side.
          body: JSON.stringify({ actionId: crypto.randomUUID(), ...body }),
        }
      );
      if (res.status === 409) {
        // V4-001 reconcile: a duplicate means this action was already
        // COMMITTED by an earlier attempt (there is no response replay
        // server-side). Re-GET the state instead of surfacing an error —
        // to the player the button press simply succeeded.
        const detail = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
        if (detail.duplicate) {
          const current = await fetch(
            `/api/servers/${serverId}/activities/${sessionId}`,
            { credentials: 'same-origin' }
          );
          if (current.ok) {
            const data = (await current.json()) as { activity: ActivityDetail };
            setDetail(data.activity);
          }
          return true;
        }
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        // 503 = idempotency store unavailable (retryable): a fresh press
        // generates a fresh actionId, which is the correct user-level
        // retry semantic.
        throw new Error(`${res.status} ${JSON.stringify(detail)}`);
      }
      // Force an immediate re-fetch so the panel reflects the new state
      // without waiting for the next 2-second poll.
      const data = (await res.json()) as { activity: { id: string; state: Record<string, unknown>; status: string } };
      if (!data?.activity) return true;
      setDetail((prev) =>
        prev
          ? { ...prev, state: data.activity.state, status: data.activity.status }
          : prev
      );
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/servers/${serverId}/activities/${sessionId}/end`,
        { method: 'POST', credentials: 'same-origin' }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${JSON.stringify(detail)}`);
      }
      onEnd();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The dispatch function handed to the plugin's renderClient. It
  // returns a promise so plugins can `await dispatch(...)` if they
  // want to; the panel ignores the return value either way.
  const dispatch = useCallback(
    (action: Record<string, unknown>) => {
      void sendAction(action);
    },
    // sendAction is recreated on every render but reads no deps from
    // the closure, so we can leave it out of the deps.
    [serverId, sessionId]
  );

  const pluginClient = detail ? getPlugin(detail.pluginId) : null;
  // beta-review: render the plugin's surface through its OWN component
  // (see PluginSurface). Inlining `renderClient(...)` here meant a plugin
  // that uses hooks borrowed this component's hook list, and because the
  // call is conditional the hook count changed between renders — React
  // #310, which took the entire voice room down with it.
  // The M16 generic surface: raw state + a free-form action form. Used
  // for plugins that ship no client UI, and while the state loads.
  const genericSurface = (
    <>
      <pre
        style={{
          background: '#07090d',
          padding: 8,
          borderRadius: 4,
          fontSize: 12,
          maxHeight: 180,
          overflow: 'auto',
          margin: '0 0 12px 0',
        }}
      >
        {detail ? JSON.stringify(detail.state, null, 2) : '…'}
      </pre>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          value={actionJson}
          onChange={(e) => setActionJson(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            padding: '6px 8px',
            background: '#11151b',
            color: '#e6e8eb',
            border: '1px solid #1f242c',
            borderRadius: 4,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
          }}
        />
        <button
          onClick={() => {
            try {
              const parsed = JSON.parse(actionJson) as Record<string, unknown>;
              void sendAction(parsed);
            } catch (err) {
              setError(`Invalid JSON: ${(err as Error).message}`);
            }
          }}
          disabled={busy}
        >
          {busy ? '…' : 'Send action'}
        </button>
        <button onClick={end} disabled={busy}>
          End
        </button>
      </div>
    </>
  );

  return (
    <div
      style={{
        border: '1px solid #2a3140',
        borderRadius: 8,
        background: '#0e1218',
        padding: 16,
        maxWidth: 640,
        marginTop: 16,
      }}
    >
      <strong>Activity: {detail?.pluginId ?? '…'}</strong>
      {detail && (
        <p style={{ color: '#9aa3ad', margin: '4px 0 8px 0', fontSize: 13 }}>
          status: <code>{detail.status}</code> · players: {detail.players.length}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        {pluginClient && detail ? (
          <PluginSurface
            render={pluginClient.renderClient}
            props={{
              state: detail.state,
              dispatch: (action: unknown) => dispatch(action as Record<string, unknown>),
              actorUserId: actorUserId ?? '',
              hostUserId: detail.createdBy,
              players: detail.players.map((p) => ({ userId: p.userId, name: p.name ?? null })),
              cardPacks,
            }}
            fallback={genericSurface}
          />
        ) : (
          genericSurface
        )}
      </div>
      {error && <p style={{ color: '#e36049', marginTop: 8, fontSize: 13 }}>{error}</p>}
    </div>
  );
}

export default function RoomPage({ params }: { params: Promise<{ roomName: string }> }) {
  const [roomName, setRoomName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await params;
      if (!cancelled) setRoomName(resolved.roomName);
    })();
    return () => {
      cancelled = true;
    };
  }, [params]);

  if (!roomName) {
    return <p>Loading…</p>;
  }

  return (
    <Suspense fallback={<p>Loading room…</p>}>
      <RoomView roomName={roomName} />
    </Suspense>
  );
}
