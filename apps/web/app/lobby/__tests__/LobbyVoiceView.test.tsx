// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionState } from 'livekit-client';
import { LobbyVoiceView } from '../LobbyVoiceView';
import { LobbyVoiceContext, type LobbyVoiceContextValue } from '../LobbyVoiceProvider';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function makeVoice(overrides: Partial<LobbyVoiceContextValue> = {}): LobbyVoiceContextValue {
  return {
    serverId: 'srv-1',
    livekitUrl: 'ws://localhost:7880',
    activeChannelId: 'ch-1',
    connectionState: ConnectionState.Connected,
    connecting: false,
    error: null,
    micEnabled: true,
    cameraEnabled: false,
    screenShareEnabled: false,
    screenSharePolicy: { maxHeight: 1080, maxFps: 30 },
    screenSharePreference: { quality: 'high', fps: '30' },
    deafenEnabled: false,
    participants: [],
    mainViewMode: 'voice',
    activeTextChannelId: null,
    activeTextChannelName: 'general',
    connectToChannel: vi.fn(),
    disconnect: vi.fn(),
    toggleMic: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
    setScreenSharePreference: vi.fn(),
    toggleDeafen: vi.fn(),
    setMainViewMode: vi.fn(),
    setActiveTextChannel: vi.fn(),
    getParticipantCameraTrack: vi.fn(() => null),
    getParticipantScreenShareTrack: vi.fn(() => null),
    isScreenShareJoined: vi.fn(() => false),
    joinScreenShare: vi.fn(),
    leaveScreenShare: vi.fn(),
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

function renderView(voice: LobbyVoiceContextValue, locale = 'en') {
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyVoiceView channelId="ch-1" channelName="Main Lounge" />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

describe('LobbyVoiceView', () => {
  it('labels the call controls the way the voice footer does', () => {
    renderView(makeVoice());
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deafen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect from voice' })).toBeInTheDocument();
    expect(screen.getByText('Connecting to voice')).toBeInTheDocument();
  });

  it('shows the stream quality menu with the server limit', () => {
    renderView(makeVoice());
    fireEvent.click(screen.getByRole('button', { name: 'Stream quality' }));
    expect(screen.getByText('Frame rate')).toBeInTheDocument();
    expect(screen.getByText('Server maximum: 1080p / 30 FPS')).toBeInTheDocument();
  });

  it('renders its chrome, uppercase labels included, in the active language', () => {
    renderView(makeVoice(), 'tr');
    expect(screen.getByRole('button', { name: 'Mikrofonu kapat' })).toBeInTheDocument();
    expect(screen.getByText('Sese bağlanılıyor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yayın kalitesi' }));
    expect(screen.getByText('Kare hızı')).toBeInTheDocument();
    expect(screen.getByText('Sunucu sınırı: 1080p / 30 FPS')).toBeInTheDocument();
  });
});
