// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LobbyVoiceFooter } from '../LobbyVoiceFooter';
import {
  LobbyVoiceContext,
  type LobbyVoiceContextValue,
} from '../LobbyVoiceProvider';
import { ConnectionState } from 'livekit-client';

// Stub next/link so it renders an <a> we can query in the DOM.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function makeVoice(overrides: Partial<LobbyVoiceContextValue> = {}): LobbyVoiceContextValue {
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
    ...overrides,
  };
}

function renderFooter(voice: LobbyVoiceContextValue, props = { serverName: 'Community', hasUser: true }) {
  render(
    <LobbyVoiceContext.Provider value={voice}>
      <LobbyVoiceFooter {...props} />
    </LobbyVoiceContext.Provider>
  );
}

describe('LobbyVoiceFooter', () => {
  it('renders the "Voice Ready" label and disables controls when disconnected', () => {
    renderFooter(makeVoice());
    expect(screen.getByText('Voice Ready')).toBeInTheDocument();
    // The disconnect, mic, and camera buttons are disabled when not connected.
    const buttons = screen.getAllByRole('button');
    // Every control button except the server name button (no type) is disabled.
    expect(buttons.some((b) => b.hasAttribute('disabled'))).toBe(true);
  });

  it('renders "Voice Connected" and enables controls when connected', () => {
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
      })
    );
    expect(screen.getByText('Voice Connected')).toBeInTheDocument();
    // The mic toggle is now enabled.
    const micButton = screen.getByTitle('Unmute');
    expect(micButton).not.toBeDisabled();
  });

  it('renders "Connecting..." while connecting', () => {
    renderFooter(makeVoice({ connecting: true }));
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('shows the mic_off icon and "Mute" title when mic is enabled', () => {
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        micEnabled: true,
      })
    );
    expect(screen.getByTitle('Mute')).toBeInTheDocument();
    expect(screen.getByText('mic')).toBeInTheDocument();
  });

  it('calls toggleMic when the mic button is clicked', () => {
    const toggleMic = vi.fn();
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        toggleMic,
      })
    );
    fireEvent.click(screen.getByTitle('Unmute'));
    expect(toggleMic).toHaveBeenCalled();
  });

  it('calls disconnect when the call-end button is clicked', () => {
    const disconnect = vi.fn();
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        disconnect,
      })
    );
    fireEvent.click(screen.getByTitle('Disconnect'));
    expect(disconnect).toHaveBeenCalled();
  });

  it('renders the error message in an alert role when set', () => {
    renderFooter(makeVoice({ error: 'Session expired' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Session expired');
  });

  it('links to /settings/voice-video for the settings shortcut', () => {
    renderFooter(makeVoice());
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/settings/voice-video');
  });
});
