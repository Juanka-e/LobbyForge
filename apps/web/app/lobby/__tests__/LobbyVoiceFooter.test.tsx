// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LobbyVoiceFooter } from '../LobbyVoiceFooter';
import {
  LobbyVoiceContext,
  type LobbyVoiceContextValue,
} from '../LobbyVoiceProvider';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
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
    presenceStatus: 'online',
    setPresenceStatus: vi.fn(),
    activeDm: null,
    activeActivityChannel: null,
    openDm: vi.fn(),
    openActivities: vi.fn(),
    ...overrides,
  };
}

/**
 * The footer's chrome is translated, so the language is pinned here
 * rather than inherited from the provider's default — otherwise these
 * assertions would quietly start testing whatever `DEFAULT_APP_LOCALE`
 * happens to be.
 */
function renderFooter(
  voice: LobbyVoiceContextValue,
  props = { serverName: 'Community', hasUser: true },
  locale = 'en'
) {
  render(
    // The real catalogues from disk, exactly as the layout serves them.
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyVoiceFooter {...props} />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
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

  it('renders its chrome in the active language', () => {
    renderFooter(makeVoice(), { serverName: 'Community', hasUser: true }, 'tr');
    expect(screen.getByText('Ses Hazır')).toBeInTheDocument();
    expect(screen.getByTitle('Bağlantıyı kes')).toBeInTheDocument();
  });

  // security-review AUTHZ-006 follow-up: a timeout grants canPublish:false,
  // so the mic, camera and screen share cannot be turned on at all.
  it('a timed-out member sees "Timed out" and cannot turn on the mic, camera or screen share', () => {
    const toggleMic = vi.fn();
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        serverMuted: true,
        publishBlocked: true,
        publishBlockedReason: 'timeout',
        toggleMic,
      })
    );
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    const blocked = screen.getAllByTitle('Unavailable while you are timed out');
    // Screen share, camera and mic.
    expect(blocked).toHaveLength(3);
    for (const button of blocked) expect(button).toBeDisabled();
    fireEvent.click(blocked[2]);
    expect(toggleMic).not.toHaveBeenCalled();
    expect(screen.getByTitle('Disconnect')).not.toBeDisabled();
  });

  it('a camera that is still on can be switched off while publishing is blocked', () => {
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        serverMuted: true,
        publishBlocked: true,
        publishBlockedReason: 'timeout',
        cameraEnabled: true,
      })
    );
    expect(screen.getByTitle('Turn off camera')).not.toBeDisabled();
  });

  it('a server-muted member keeps camera and screen share, and the mic explains the mute', () => {
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        serverMuted: true,
        publishBlocked: false,
        publishBlockedReason: 'server_mute',
      })
    );
    expect(screen.getByText('Server muted')).toBeInTheDocument();
    // Still clickable: the click surfaces the "a moderator muted you" notice.
    expect(screen.getByTitle('Muted by a moderator')).not.toBeDisabled();
    expect(screen.getByTitle('Turn on camera')).not.toBeDisabled();
    expect(screen.getByTitle('Share your screen')).not.toBeDisabled();
  });

  it('words the timeout in the active language', () => {
    renderFooter(
      makeVoice({
        connectionState: ConnectionState.Connected,
        activeChannelId: 'ch-1',
        serverMuted: true,
        publishBlocked: true,
        publishBlockedReason: 'timeout',
      }),
      { serverName: 'Community', hasUser: true },
      'tr'
    );
    expect(screen.getByText('Zaman aşımındasın')).toBeInTheDocument();
    expect(screen.getAllByTitle('Zaman aşımındayken kullanılamaz')).toHaveLength(3);
  });

  it('links to /settings/voice-video for the settings shortcut', () => {
    renderFooter(makeVoice());
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/settings/voice-video');
  });
});
