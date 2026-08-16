/**
 * Voice-room UI.
 *
 * Flow (mirrors the M9 connect page but actually connects):
 *   1. Mount → if no session, POST /api/auth/guest.
 *   2. POST /api/livekit/token with serverId + channelId -> get a JWT.
 *   3. new Room({ adaptiveStream, dynacast }).connect(WS_URL, JWT).
 *   4. Render the local + remote participant list. Mic toggle uses
 *      `localParticipant.setMicrophoneEnabled`. Deafen is a UI hint only
 *      in M14 (toggles a flag that mutes incoming audio via
 *      `setSubscribedTracks`); server-side mute is M15.
 *   5. If `serverId` + `channelId` query params are present, post a
 *      presence heartbeat every 5s to /api/servers/{id}/channels/{channelId}/presence.
 *
 * M14 scope is self-mute/deafen only. Server-side mute (M15) needs
 * `livekit-server-sdk` and a `RoomServiceClient.muteParticipant` call.
 *
 * The page reads `NEXT_PUBLIC_LIVEKIT_URL` (browser-visible) so Next can
 * inline it at build time. The token + cookie exchange happens server-side
 * and the JWT never carries the API secret.
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Room,
  RoomEvent,
  ConnectionState,
  type LocalParticipant,
  type Participant,
} from 'livekit-client';
import { getPlugin } from '@/lib/plugin-registry';
import { getRealtimeClient } from '@/lib/realtime-client';

type Guest = { gid: string; uid: string | null; name: string };
type Token = { token: string; identity: string; room: string; expiresAt: number };
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
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? 'ws://localhost:7880';

  const [guest, setGuest] = useState<Guest | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [roomState, setRoomState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
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

        await room.connect(livekitUrl, token.token);
        if (cancelled) {
          await room.disconnect();
          return;
        }
        collectParticipants(room);
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
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [guest, serverId, channelId, livekitUrl, collectParticipants]);

  // 3. Presence heartbeat — only if serverId + channelId are in the query string.
  useEffect(() => {
    if (!serverId || !channelId) return;
    if (!guest?.uid) return;

    const post = async () => {
      try {
        await fetch(`/api/servers/${serverId}/channels/${channelId}/presence`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'online' }),
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
    try {
      const next = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  }, [micEnabled]);

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !deafened;
    setDeafened(next);
    if (next) {
      // Mute every remote track. M14 is self-only — no livekit-server-sdk.
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.track) pub.track.setMuted(true);
        }
      }
    } else {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.track) pub.track.setMuted(false);
        }
      }
    }
  }, [deafened]);

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
          {deafened ? 'Undeafen' : 'Deafen (UI only)'}
        </button>
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

    try {
      const client = getRealtimeClient();
      client.connect();
      unsubscribe = client.subscribe(
        `activity-state:${serverId}:${sessionId}` as const,
        handleEvent
      );
      // If the WS connection is CLOSED (initial connect failed), drop to polling.
      if (client.readyState === WebSocket.CLOSED) {
        pollFallback = true;
      }
    } catch {
      pollFallback = true;
    }

    if (pollFallback) {
      // 5s polling cadence — recovery lane when WS isn't available.
      void fetchOnce();
      pollTimer = setInterval(fetchOnce, 5_000);
    }

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
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
  const pluginUi =
    pluginClient && detail
      ? pluginClient.renderClient({
          state: detail.state,
          dispatch: (action: unknown) => dispatch(action as Record<string, unknown>),
          actorUserId: actorUserId ?? '',
          hostUserId: detail.createdBy,
          players: detail.players.map((p) => ({ userId: p.userId, name: p.name ?? null })),
          cardPacks,
        })
      : null;

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
      {pluginUi ? (
        <div style={{ marginTop: 12 }}>{pluginUi}</div>
      ) : (
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
      )}
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
