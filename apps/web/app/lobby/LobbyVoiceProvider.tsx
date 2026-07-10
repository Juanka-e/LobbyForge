'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  type LocalTrack,
  type Participant,
  type RemoteTrack,
  type AudioCaptureOptions,
  type VideoCaptureOptions,
  type ScreenShareCaptureOptions,
} from 'livekit-client';
import {
  mergeVoiceVideoPreferences,
  type VoiceVideoPreferences,
} from '@/lib/voice-video-preferences';
import {
  mergeKeybindPreferences,
  type KeybindPreferences,
} from '@/lib/keybind-preferences';

/**
 * M21.4a - LiveKit voice connection scoped to the standalone lobby.
 *
 * The provider owns a single `livekit-client` `Room` and exposes the
 * minimal surface the sidebar voice channels + the voice footer need:
 *
 *   - `connectToChannel(channelId)` - disconnects any current room,
 *     mints a LiveKit JWT scoped to `(serverId, channelId)` through
 *     `/api/livekit/token`, connects, publishes the local mic (muted
 *     by default), and starts the 5s presence heartbeat.
 *   - `disconnect()` - tears down the room + heartbeat.
 *   - `toggleMic()` - flips `localParticipant.setMicrophoneEnabled`.
 *   - `connectionState`, `participants`, `micEnabled`, `activeChannelId`,
 *     `connecting`, `error` - render state.
 *
 * The provider is intentionally narrow: video tile grid + screen share
 * are M21.4b/c. This slice ships the "click a voice channel in the
 * lobby -> audio connects inline, no page navigation" loop.
 */

export interface LobbyVoiceParticipant {
  id: string;
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  micEnabled: boolean;
  /** True when this participant is publishing a camera track. */
  cameraEnabled: boolean;
  /** True when this participant is publishing a screen-share track. */
  hasScreenShare: boolean;
}

interface LobbyVoiceContextValue {
  serverId: string;
  livekitUrl: string;
  activeChannelId: string | null;
  connectionState: ConnectionState;
  connecting: boolean;
  error: string | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  deafenEnabled: boolean;
  participants: LobbyVoiceParticipant[];
  /** 'chat' = text channel visible; 'voice' = full-screen video grid. */
  mainViewMode: 'chat' | 'voice';
  /** Active text channel id — switchable from sidebar. */
  activeTextChannelId: string | null;
  /** Active text channel name for display. */
  activeTextChannelName: string;
  connectToChannel: (channelId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleDeafen: () => void;
  setMainViewMode: (mode: 'chat' | 'voice') => void;
  setActiveTextChannel: (channelId: string, channelName: string) => void;
  getParticipantCameraTrack: (identity: string) => MediaStreamTrack | null;
  getParticipantScreenShareTrack: (identity: string) => MediaStreamTrack | null;
  /** Set the local playback volume (0..1) for a remote participant's audio. */
  setRemoteVolume: (identity: string, volume: number) => void;
  /** Get the current local playback volume for a remote participant. */
  getRemoteVolume: (identity: string) => number;
}

const LobbyVoiceContext = createContext<LobbyVoiceContextValue | null>(null);

const HEARTBEAT_INTERVAL_MS = 5_000;

interface Guest {
  gid: string;
  uid: string | null;
  name: string;
}

interface TokenResponse {
  token: string;
  identity: string;
  room: string;
  expiresAt: number;
  serverVoiceSettings?: {
    requirePushToTalk: boolean;
    startMuted: boolean;
  };
}

type SettingsResponse = {
  settings: {
    audio: Record<string, unknown>;
    keybinds: Record<string, unknown>;
  };
};

function audioCaptureOptions(prefs: VoiceVideoPreferences): AudioCaptureOptions {
  return {
    deviceId: prefs.inputDeviceId && prefs.inputDeviceId !== 'default'
      ? { exact: prefs.inputDeviceId }
      : undefined,
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.automaticGainControl,
  };
}

function cameraCaptureOptions(prefs: VoiceVideoPreferences): VideoCaptureOptions {
  return {
    deviceId: prefs.cameraDeviceId && prefs.cameraDeviceId !== 'default'
      ? { exact: prefs.cameraDeviceId }
      : undefined,
    frameRate: Number(prefs.screenFps),
  };
}

function screenShareOptions(prefs: VoiceVideoPreferences): ScreenShareCaptureOptions {
  const resolution =
    prefs.screenQuality === 'low'
      ? { width: 854, height: 480 }
      : prefs.screenQuality === 'standard'
        ? { width: 1280, height: 720 }
        : prefs.screenQuality === 'high'
          ? { width: 1920, height: 1080 }
          : undefined;
  return {
    audio: prefs.shareSystemAudio,
    systemAudio: prefs.shareSystemAudio ? 'include' : 'exclude',
    resolution,
  };
}

function participantToView(
  p: Participant,
  knownNames: Record<string, string>
): LobbyVoiceParticipant {
  const identity = p.identity;
  const isLocal = p.isLocal;
  const pubs = Array.from(p.videoTrackPublications.values());
  const audioPub = Array.from(p.audioTrackPublications.values())[0];
  const micEnabled = isLocal
    ? !!audioPub?.track
    : !!audioPub?.track && !audioPub.track.isMuted;
  const cameraEnabled = pubs.some((pub) => pub.source === 'camera' && !!pub.track);
  const hasScreenShare = pubs.some((pub) => pub.source === 'screen_share' && !!pub.track);
  return {
    id: identity,
    identity,
    name: p.name || knownNames[identity] || identity,
    isLocal,
    isSpeaking: p.isSpeaking,
    micEnabled,
    cameraEnabled,
    hasScreenShare,
  };
}

export interface LobbyVoiceProviderProps {
  serverId: string;
  livekitUrl: string;
  /** Initial name lookup for participant identity -> display name. */
  knownNames: Record<string, string>;
  /** Display name for the local participant (sent on mic publish). */
  localDisplayName: string;
  /** Initial active text channel (from SSR). */
  initialTextChannelId?: string | null;
  initialTextChannelName?: string;
  children: ReactNode;
}

export function LobbyVoiceProvider({
  serverId,
  livekitUrl,
  knownNames,
  localDisplayName,
  initialTextChannelId,
  initialTextChannelName,
  children,
}: LobbyVoiceProviderProps) {
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Disconnected
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [screenShareEnabled, setScreenShareEnabled] = useState(false);
  const [deafenEnabled, setDeafenEnabled] = useState(false);
  const [participants, setParticipants] = useState<LobbyVoiceParticipant[]>([]);
  const [mainViewMode, setMainViewMode] = useState<'chat' | 'voice'>('chat');
  const [activeTextChannelId, setActiveTextChannelId] = useState<string | null>(initialTextChannelId ?? null);
  const [activeTextChannelName, setActiveTextChannelName] = useState<string>(initialTextChannelName ?? 'general');

  const setActiveTextChannel = useCallback((channelId: string, channelName: string) => {
    setActiveTextChannelId(channelId);
    setActiveTextChannelName(channelName);
    setMainViewMode('chat');
  }, []);
  const [guest, setGuest] = useState<Guest | null>(null);

  const roomRef = useRef<Room | null>(null);
  const remoteAudioContainerRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioElementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cumulative bytes observed at the previous bandwidth sample. 0 means
  // "no baseline yet" — the first sample establishes the baseline and
  // reports no delta.
  const lastBandwidthBytesRef = useRef(0);
  const voicePrefsRef = useRef<VoiceVideoPreferences>(mergeVoiceVideoPreferences({}));
  const keybindPrefsRef = useRef<KeybindPreferences>(mergeKeybindPreferences({}));
  // Effective input mode after applying the server's requirePushToTalk
  // policy. Read by the push-to-talk keybind effect so the handler stays
  // active even when the server forces PTT over the user's preference.
  const effectiveInputModeRef = useRef<'voice_activity' | 'push_to_talk'>('voice_activity');
  // Live copy for event handlers (avoid re-subscribing on every render).
  const knownNamesRef = useRef<Record<string, string>>(knownNames);
  knownNamesRef.current = knownNames;

  const loadVoicePreferences = useCallback(async (): Promise<VoiceVideoPreferences> => {
    try {
      const res = await fetch('/api/settings/me', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`settings ${res.status}`);
      const data = (await res.json()) as SettingsResponse;
      const prefs = mergeVoiceVideoPreferences(data.settings.audio);
      keybindPrefsRef.current = mergeKeybindPreferences(data.settings.keybinds);
      voicePrefsRef.current = prefs;
      return prefs;
    } catch {
      const prefs = mergeVoiceVideoPreferences({});
      voicePrefsRef.current = prefs;
      return prefs;
    }
  }, []);

  const applyRemoteAudio = useCallback((room: Room, enabled: boolean) => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        publication.setEnabled(enabled);
      }
    }
  }, []);

  const detachRemoteAudio = useCallback((track?: RemoteTrack) => {
    if (track) {
      for (const element of track.detach()) {
        element.remove();
      }
      for (const [key, element] of remoteAudioElementsRef.current) {
        if (!element.isConnected) remoteAudioElementsRef.current.delete(key);
      }
      return;
    }
    for (const element of remoteAudioElementsRef.current.values()) {
      element.remove();
    }
    remoteAudioElementsRef.current.clear();
  }, []);

  const attachRemoteAudio = useCallback((track: RemoteTrack, participant: Participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    const key = `${participant.identity}:${track.sid}`;
    if (remoteAudioElementsRef.current.has(key)) return;
    const element = track.attach();
    element.autoplay = true;
    element.dataset.livekitRemoteAudio = key;
    // CRITICAL: do NOT use display:none — many browsers refuse to play
    // audio elements that are display:none or inside a display:none
    // parent. Use absolute positioning with zero size + zero opacity
    // instead. The element stays in the DOM and plays, but is invisible.
    element.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    remoteAudioContainerRef.current?.appendChild(element);
    remoteAudioElementsRef.current.set(key, element);
  }, []);

  // 1. Mint/rebind guest session once on mount. The lobby page's server
  //    component already validates the session and redirects to /login if
  //    missing - but the LiveKit token endpoint requires the cookie and
  //    we want a fresh /api/auth/guest GET to surface the uid without a
  //    page reload after first creation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const probe = await fetch('/api/auth/guest', {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (probe.ok) {
          const data = (await probe.json()) as { guest: Guest };
          if (!cancelled) setGuest(data.guest);
          return;
        }
        const res = await fetch('/api/auth/guest', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: localDisplayName || undefined }),
        });
        if (!res.ok) throw new Error(`POST /api/auth/guest -> ${res.status}`);
        const data = (await res.json()) as { guest: Guest };
        if (!cancelled) setGuest(data.guest);
      } catch (err) {
        if (!cancelled) setError((err instanceof Error ? err.message : String(err)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localDisplayName]);

  const collectParticipants = useCallback((room: Room) => {
    const list = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
    setParticipants(list.map((p) => participantToView(p, knownNamesRef.current)));
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    lastBandwidthBytesRef.current = 0;
  }, []);

  /**
   * Samples RTC stats from all local + remote audio/video tracks and
   * returns the byte delta since the previous call. Uses the public
   * `getRTCStatsReport()` API (the legacy `Room.getStats()` never existed
   * in livekit-client and failed typecheck). The first call establishes
   * a baseline and returns 0.
   */
  const sampleBandwidth = useCallback(async (): Promise<number> => {
    const room = roomRef.current;
    if (!room) return 0;

    let totalBytes = 0;
    const tracks: Array<LocalTrack | RemoteTrack> = [];

    // Local published tracks → outbound-rtp (bytesSent).
    for (const pub of room.localParticipant.audioTrackPublications.values()) {
      if (pub.track) tracks.push(pub.track as LocalTrack);
    }
    for (const pub of room.localParticipant.videoTrackPublications.values()) {
      if (pub.track) tracks.push(pub.track as LocalTrack);
    }
    // Remote subscribed tracks → inbound-rtp (bytesReceived).
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.audioTrackPublications.values()) {
        if (pub.track) tracks.push(pub.track);
      }
      for (const pub of participant.videoTrackPublications.values()) {
        if (pub.track) tracks.push(pub.track);
      }
    }

    for (const track of tracks) {
      try {
        const report = await track.getRTCStatsReport();
        if (!report) continue;
        for (const stats of report.values()) {
          const record = stats as Record<string, unknown>;
          // outbound-rtp carries bytesSent (local publishers);
          // inbound-rtp carries bytesReceived (remote subscribers).
          if (typeof record.bytesSent === 'number') {
            totalBytes += record.bytesSent;
          } else if (typeof record.bytesReceived === 'number') {
            totalBytes += record.bytesReceived;
          }
        }
      } catch {
        // A single track failing to report is non-fatal.
      }
    }

    const previous = lastBandwidthBytesRef.current;
    lastBandwidthBytesRef.current = totalBytes;
    // First sample (previous === 0) establishes the baseline → no delta.
    // A counter reset (totalBytes < previous, e.g. reconnect) → no delta.
    return previous > 0 && totalBytes > previous ? totalBytes - previous : 0;
  }, []);

  const startHeartbeat = useCallback(
    (channelId: string) => {
      stopHeartbeat();
      const post = async () => {
        try {
          const body: Record<string, unknown> = {
            serverId,
            channelId,
            status: 'online',
          };
          // Piggyback the bandwidth delta on the heartbeat. The first
          // heartbeat after connect establishes the RTC stats baseline
          // and sends no delta; subsequent ones report real deltas.
          const bandwidthDelta = await sampleBandwidth();
          if (bandwidthDelta > 0) {
            body.bandwidthDeltaBytes = bandwidthDelta;
          }
          const response = await fetch('/api/presence', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Presence heartbeat failed: ${response.status}`);
        } catch {
          // Swallow - a single missed heartbeat is fine; the 90s TTL
          // handles long disconnects server-side.
        }
      };
      void post();
      heartbeatRef.current = setInterval(post, HEARTBEAT_INTERVAL_MS);
    },
    [serverId, stopHeartbeat, sampleBandwidth]
  );


  const connectTokenRef = useRef(0);

  const connectToChannel = useCallback(
    async (channelId: string) => {
      if (activeChannelId === channelId && roomRef.current) return;
      if (!guest?.uid) {
        setError('Session not ready - try again in a moment.');
        return;
      }

      // Race guard: increment a token; if a newer connect call started
      // before we finish, bail out so we don't orphan rooms.
      const myToken = ++connectTokenRef.current;

      // Tear down any existing room first.
      if (roomRef.current) {
        try {
          await roomRef.current.disconnect();
        } catch {
          /* swallow */
        }
        roomRef.current = null;
      }
      stopHeartbeat();

      // Check if a newer connect call superseded us during the disconnect.
      if (connectTokenRef.current !== myToken) return;

      setActiveChannelId(channelId);
      setConnecting(true);
      setError(null);
      setParticipants([]);
      setMicEnabled(false);

      try {
        const voicePrefs = await loadVoicePreferences();
        if (connectTokenRef.current !== myToken) return; // superseded
        const res = await fetch('/api/livekit/token', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, channelId, displayName: localDisplayName }),
        });
        if (connectTokenRef.current !== myToken) return; // superseded
        if (res.status === 401) {
          throw new Error('Session expired - refresh the page.');
        }
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(detail.error ?? `Token endpoint returned ${res.status}`);
        }
        const token = (await res.json()) as TokenResponse;

        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          if (connectTokenRef.current !== myToken) return;
          setConnectionState(state);
        });
        room.on(RoomEvent.Disconnected, () => {
          if (roomRef.current !== room) return;
          roomRef.current = null;
          detachRemoteAudio();
          stopHeartbeat();
          setActiveChannelId(null);
          setParticipants([]);
          setMicEnabled(false);
          setCameraEnabled(false);
          setScreenShareEnabled(false);
          setDeafenEnabled(false);
          setConnectionState(ConnectionState.Disconnected);
        });
        room.on(RoomEvent.ParticipantConnected, () => collectParticipants(room));
        room.on(RoomEvent.ParticipantDisconnected, () => collectParticipants(room));
        room.on(RoomEvent.ActiveSpeakersChanged, () => collectParticipants(room));
        room.on(RoomEvent.TrackMuted, () => collectParticipants(room));
        room.on(RoomEvent.TrackUnmuted, () => collectParticipants(room));
        room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
          attachRemoteAudio(track, participant);
          collectParticipants(room);
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          detachRemoteAudio(track);
          collectParticipants(room);
        });
        room.on(RoomEvent.LocalTrackPublished, () => collectParticipants(room));
        room.on(RoomEvent.LocalTrackUnpublished, () => collectParticipants(room));

        await room.connect(livekitUrl, token.token);
        if (connectTokenRef.current !== myToken) {
          // Superseded — clean up the room we just connected.
          void room.disconnect();
          return;
        }
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.audioTrackPublications.values()) {
            if (publication.track) attachRemoteAudio(publication.track, participant);
          }
        }
        // Apply server-side voice policy on top of the user preference.
        // requirePushToTalk forces PTT regardless of the user's inputMode;
        // startMuted forces the mic off on join. Both compose naturally
        // (PTT also starts muted until the key is held).
        const serverRequiresPTT = token.serverVoiceSettings?.requirePushToTalk ?? false;
        const serverStartMuted = token.serverVoiceSettings?.startMuted ?? false;
        const effectiveInputMode = serverRequiresPTT ? 'push_to_talk' : voicePrefs.inputMode;
        effectiveInputModeRef.current = effectiveInputMode;
        const shouldStartMic = !serverStartMuted && effectiveInputMode === 'voice_activity';
        await room.localParticipant.setMicrophoneEnabled(shouldStartMic, audioCaptureOptions(voicePrefs));
        voicePrefsRef.current = voicePrefs;
        setMicEnabled(shouldStartMic);
        collectParticipants(room);
        startHeartbeat(channelId);
      } catch (err) {
        if (connectTokenRef.current !== myToken) return; // superseded
        const failedRoom = roomRef.current;
        if (failedRoom) void failedRoom.disconnect();
        setError(err instanceof Error ? err.message : String(err));
        setActiveChannelId(null);
        roomRef.current = null;
        stopHeartbeat();
      } finally {
        if (connectTokenRef.current === myToken) {
          setConnecting(false);
        }
      }
    },
    [
      activeChannelId,
      guest?.uid,
      serverId,
      livekitUrl,
      localDisplayName,
      collectParticipants,
      startHeartbeat,
      stopHeartbeat,
      attachRemoteAudio,
      detachRemoteAudio,
      loadVoicePreferences,
    ]
  );

  const disconnect = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.disconnect();
    } catch {
      /* swallow */
    }
    roomRef.current = null;
    stopHeartbeat();
    setActiveChannelId(null);
    setParticipants([]);
    setMicEnabled(false);
    setConnectionState(ConnectionState.Disconnected);
  }, [stopHeartbeat]);

  const toggleMic = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !micEnabled;
    try {
      const prefs = await loadVoicePreferences();
      await r.localParticipant.setMicrophoneEnabled(next, audioCaptureOptions(prefs));
      setMicEnabled(next);
      collectParticipants(r);
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)));
    }
  }, [micEnabled, collectParticipants, loadVoicePreferences]);

  const toggleCamera = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !cameraEnabled;
    try {
      const prefs = await loadVoicePreferences();
      await r.localParticipant.setCameraEnabled(next, cameraCaptureOptions(prefs));
      setCameraEnabled(next);
      if (next) setMainViewMode('voice');
      collectParticipants(r);
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)));
    }
  }, [cameraEnabled, collectParticipants, loadVoicePreferences]);

  const toggleScreenShare = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !screenShareEnabled;
    try {
      const prefs = await loadVoicePreferences();
      await r.localParticipant.setScreenShareEnabled(next, screenShareOptions(prefs));
      setScreenShareEnabled(next);
      if (next) setMainViewMode('voice');
      collectParticipants(r);
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)));
    }
  }, [screenShareEnabled, collectParticipants, loadVoicePreferences]);

  const toggleDeafen = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const next = !deafenEnabled;
    applyRemoteAudio(r, !next);
    setDeafenEnabled(next);
  }, [applyRemoteAudio, deafenEnabled]);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected || !activeChannelId) return;

    let held = false;
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
    };
    const setPushToTalkMic = async (next: boolean) => {
      const r = roomRef.current;
      const prefs = voicePrefsRef.current;
      // Honor the effective input mode — which may be forced to
      // push_to_talk by the server's requirePushToTalk policy.
      if (!r || effectiveInputModeRef.current !== 'push_to_talk') return;
      try {
        await r.localParticipant.setMicrophoneEnabled(next, audioCaptureOptions(prefs));
        setMicEnabled(next);
        collectParticipants(r);
      } catch (err) {
        setError((err instanceof Error ? err.message : String(err)));
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== keybindPrefsRef.current.pushToTalk.code || event.repeat || isEditableTarget(event.target)) return;
      held = true;
      event.preventDefault();
      void setPushToTalkMic(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== keybindPrefsRef.current.pushToTalk.code || isEditableTarget(event.target)) return;
      held = false;
      event.preventDefault();
      void setPushToTalkMic(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (held) void setPushToTalkMic(false);
    };
  }, [activeChannelId, collectParticipants, connectionState]);

  /**
   * Look up a remote participant's camera track. Used by the video tile
   * to attach `<video>` directly to the LiveKit track without going
   * through `@livekit/components-react`.
   */
  const getParticipantCameraTrack = useCallback((identity: string): MediaStreamTrack | null => {
    const r = roomRef.current;
    if (!r) return null;
    if (identity === r.localParticipant.identity) {
      for (const pub of r.localParticipant.videoTrackPublications.values()) {
        if (pub.track && pub.source === 'camera') return pub.track.mediaStreamTrack;
      }
      return null;
    }
    const p = r.remoteParticipants.get(identity);
    if (!p) return null;
    for (const pub of p.videoTrackPublications.values()) {
      if (pub.track && pub.source === 'camera') return pub.track.mediaStreamTrack;
    }
    return null;
  }, []);

  /**
   * Same as `getParticipantCameraTrack` but for screen-share tracks.
   * Used by the large pinned tile when someone is sharing their screen.
   */
  const getParticipantScreenShareTrack = useCallback((identity: string): MediaStreamTrack | null => {
    const r = roomRef.current;
    if (!r) return null;
    if (identity === r.localParticipant.identity) {
      for (const pub of r.localParticipant.videoTrackPublications.values()) {
        if (pub.track && pub.source === 'screen_share') return pub.track.mediaStreamTrack;
      }
      return null;
    }
    const p = r.remoteParticipants.get(identity);
    if (!p) return null;
    for (const pub of p.videoTrackPublications.values()) {
      if (pub.track && pub.source === 'screen_share') return pub.track.mediaStreamTrack;
    }
    return null;
  }, []);

  /**
   * Per-user volume control (Discord-style). Each remote participant's
   * audio element volume can be individually adjusted by the local user.
   * Stored in localStorage so it persists across sessions. Volume is 0..1.
   */
  const setRemoteVolume = useCallback((identity: string, volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume));
    try {
      const key = `lf-vol-${identity}`;
      window.localStorage.setItem(key, String(clamped));
    } catch { /* localStorage disabled — non-fatal */ }
    // Apply to all audio elements for this participant
    for (const [key, element] of remoteAudioElementsRef.current) {
      if (key.startsWith(`${identity}:`)) {
        element.volume = clamped;
      }
    }
  }, []);

  const getRemoteVolume = useCallback((identity: string): number => {
    try {
      const key = `lf-vol-${identity}`;
      const stored = window.localStorage.getItem(key);
      return stored !== null ? Number(stored) : 1;
    } catch {
      return 1;
    }
  }, []);

  // Unmount: tear down room + heartbeat.
  useEffect(() => {
    return () => {
      const r = roomRef.current;
      if (r) {
        void r.disconnect();
        roomRef.current = null;
      }
      detachRemoteAudio();
      stopHeartbeat();
    };
  }, [detachRemoteAudio, stopHeartbeat]);

  // Reset camera/screen-share state on disconnect so the footer UI
  // doesn't show stale "on" state when the user reconnects.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected && !activeChannelId) {
      setCameraEnabled(false);
      setScreenShareEnabled(false);
      setDeafenEnabled(false);
    }
  }, [connectionState, activeChannelId]);

  // Apply deafen state to remote audio tracks. Only depends on
  // deafenEnabled — NOT participants — to avoid a potential render
  // loop (setEnabled → events → collectParticipants → setParticipants
  // → effect reruns).
  useEffect(() => {
    const r = roomRef.current;
    if (!r) return;
    applyRemoteAudio(r, !deafenEnabled);
  }, [deafenEnabled, applyRemoteAudio]);

  useEffect(() => {
    if (activeChannelId && participants.some((participant) => participant.hasScreenShare)) {
      setMainViewMode('voice');
    }
  }, [activeChannelId, participants]);

  const value = useMemo<LobbyVoiceContextValue>(
    () => ({
      serverId,
      livekitUrl,
      activeChannelId,
      connectionState,
      connecting,
      error,
      micEnabled,
      cameraEnabled,
      screenShareEnabled,
      deafenEnabled,
      participants,
      mainViewMode,
      activeTextChannelId,
      activeTextChannelName,
      connectToChannel,
      disconnect,
      toggleMic,
      toggleCamera,
      toggleScreenShare,
      toggleDeafen,
      setMainViewMode,
      setActiveTextChannel,
      getParticipantCameraTrack,
      getParticipantScreenShareTrack,
      setRemoteVolume,
      getRemoteVolume,
    }),
    [
      serverId,
      livekitUrl,
      activeChannelId,
      connectionState,
      connecting,
      error,
      micEnabled,
      cameraEnabled,
      screenShareEnabled,
      deafenEnabled,
      participants,
      mainViewMode,
      activeTextChannelId,
      activeTextChannelName,
      connectToChannel,
      disconnect,
      toggleMic,
      toggleCamera,
      toggleScreenShare,
      toggleDeafen,
      setMainViewMode,
      setActiveTextChannel,
      getParticipantCameraTrack,
      getParticipantScreenShareTrack,
      setRemoteVolume,
      getRemoteVolume,
    ]
  );

  return (
    <LobbyVoiceContext.Provider value={value}>
      {children}
        <div ref={remoteAudioContainerRef} aria-hidden style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none', overflow: 'hidden' }} />
    </LobbyVoiceContext.Provider>
  );
}

export function useLobbyVoice(): LobbyVoiceContextValue {
  const ctx = useContext(LobbyVoiceContext);
  if (!ctx) {
    throw new Error('useLobbyVoice must be used inside <LobbyVoiceProvider>');
  }
  return ctx;
}

export { ConnectionState };
export type { Participant };



