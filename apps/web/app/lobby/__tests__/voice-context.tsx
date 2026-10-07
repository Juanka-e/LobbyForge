/**
 * A mocked `LobbyVoiceContext` value for component tests that render
 * lobby pieces without the LiveKit provider. Not a test file itself (the
 * vitest globs only pick up `*.test.tsx`).
 */
import { vi } from 'vitest';
import { ConnectionState } from 'livekit-client';
import type { LobbyVoiceContextValue, LobbyVoiceParticipant } from '../LobbyVoiceProvider';

export function participant(identity: string, name: string, overrides: Partial<LobbyVoiceParticipant> = {}): LobbyVoiceParticipant {
  return {
    id: `p-${identity}`,
    identity,
    name,
    isLocal: false,
    isSpeaking: false,
    micEnabled: true,
    cameraEnabled: false,
    hasScreenShare: false,
    ...overrides,
  };
}

export function makeVoice(overrides: Partial<LobbyVoiceContextValue> = {}): LobbyVoiceContextValue {
  return {
    serverId: 'srv-1',
    livekitUrl: 'ws://localhost:7880',
    activeChannelId: null,
    connectionState: ConnectionState.Disconnected,
    connecting: false,
    error: null,
    micEnabled: false,
    cameraEnabled: false,
    screenShareEnabled: false,
    screenSharePolicy: { maxHeight: 1080, maxFps: 30 },
    screenSharePreference: { quality: 'high', fps: '30' },
    deafenEnabled: false,
    participants: [],
    mainViewMode: 'chat',
    activeTextChannelId: null,
    activeTextChannelName: 'general',
    connectToChannel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    toggleMic: vi.fn(async () => {}),
    toggleCamera: vi.fn(async () => {}),
    toggleScreenShare: vi.fn(async () => {}),
    setScreenSharePreference: vi.fn(async () => {}),
    toggleDeafen: vi.fn(),
    setMainViewMode: vi.fn(),
    setActiveTextChannel: vi.fn(),
    getParticipantCameraTrack: vi.fn(() => null),
    getParticipantScreenShareTrack: vi.fn(() => null),
    isScreenShareJoined: vi.fn(() => false),
    joinScreenShare: vi.fn(async () => {}),
    leaveScreenShare: vi.fn(async () => {}),
    setRemoteVolume: vi.fn(),
    getRemoteVolume: vi.fn(() => 1),
    presenceStatus: 'online',
    setPresenceStatus: vi.fn(),
    activeDm: null,
    activeActivityChannel: null,
    openDm: vi.fn(),
    openActivities: vi.fn(),
    ...overrides,
  };
}
