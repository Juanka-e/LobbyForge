// @vitest-environment happy-dom
/**
 * While LiveKit reconnects, the person is still in voice (the footer says
 * "Reconnecting..."). The A-to-Z run found two views that read the drop as
 * having left, because they checked `Connected` only:
 *
 *  - the full-screen voice view closed back to chat;
 *  - the activity view showed "Join the voice channel to play".
 *
 * Both reconnect states (SignalReconnecting first, then Reconnecting) now
 * count as in the room (lib/voice-connection.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionState } from 'livekit-client';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { isInVoiceRoom, isVoiceReconnecting } from '@/lib/voice-connection';
import { LobbyMainArea } from '../LobbyMainArea';
import { LobbyActivityView } from '../LobbyActivityView';
import { LobbyVoiceContext } from '../LobbyVoiceProvider';
import type { InstalledApp } from '../page';
import { makeVoice } from './voice-context';

vi.mock('../LobbyVoiceView', () => ({
  LobbyVoiceView: ({ channelName }: { channelName: string }) => <div data-testid="voice-view">{channelName}</div>,
}));
vi.mock('../LobbyComposer', () => ({ LobbyComposer: () => <div data-testid="composer" /> }));
vi.mock('../LobbyLiveRoster', () => ({ LobbyLiveRoster: () => <div data-testid="chat" /> }));
vi.mock('../slash/useUserInteractionFeed', () => ({ useUserInteractionFeed: () => undefined }));
vi.mock('../slash/InteractionRows', () => ({
  InteractionAnnouncer: () => null,
  InteractionHeader: () => null,
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ connect: () => {}, subscribe: () => () => {}, onReconnect: () => () => {}, readyState: 1 }),
}));
vi.mock('@/lib/plugin-registry', () => ({ getPlugin: () => null }));
vi.mock('../PluginFrame', () => ({ PluginFrameSurface: () => <div data-testid="frame" /> }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const SERVER = 'srv-1';
const VOICE = 'v-1';
const RECONNECTING = [ConnectionState.SignalReconnecting, ConnectionState.Reconnecting] as const;

describe('lib/voice-connection', () => {
  it('counts both reconnect states as reconnecting, and as still in the room', () => {
    for (const state of RECONNECTING) {
      expect(isVoiceReconnecting(state)).toBe(true);
      expect(isInVoiceRoom(state)).toBe(true);
    }
    expect(isVoiceReconnecting(ConnectionState.Connected)).toBe(false);
    expect(isInVoiceRoom(ConnectionState.Connected)).toBe(true);
  });

  it('counts nothing else as in the room', () => {
    for (const state of [ConnectionState.Disconnected, ConnectionState.Connecting, null, undefined]) {
      expect(isInVoiceRoom(state)).toBe(false);
      expect(isVoiceReconnecting(state)).toBe(false);
    }
  });
});

describe('the full-screen voice view', () => {
  function renderMain(connectionState: ConnectionState) {
    const voice = makeVoice({ activeChannelId: VOICE, connectionState, mainViewMode: 'voice' });
    return render(
      <I18nProvider {...providerPropsFor('en')}>
        <LobbyVoiceContext.Provider value={voice}>
          <LobbyMainArea
            canVoice
            data={{
              serverName: 'Night Owls',
              serverId: SERVER,
              textChannels: [{ id: 't-1', name: 'general', category: 'text' }],
              voiceChannels: [{ id: VOICE, name: 'Lounge', category: 'voice' }],
              activeTextChannel: { id: 't-1', name: 'general', category: 'text' },
              activeVoiceChannel: null,
              currentUserId: 'u-me',
              currentDisplayName: 'Me',
              messages: [],
              isLive: true,
              canManageMessages: false,
              adminLinks: { appSettings: null },
              installedApps: [],
            }}
          />
        </LobbyVoiceContext.Provider>
      </I18nProvider>
    );
  }

  it.each(RECONNECTING)('stays open while LiveKit is %s', (state) => {
    renderMain(state);
    expect(screen.getByTestId('voice-view')).toHaveTextContent('Lounge');
    expect(screen.queryByTestId('chat')).toBeNull();
  });

  it('is open when connected, and gives way to the chat once disconnected', () => {
    const { unmount } = renderMain(ConnectionState.Connected);
    expect(screen.getByTestId('voice-view')).toBeInTheDocument();
    unmount();
    renderMain(ConnectionState.Disconnected);
    expect(screen.queryByTestId('voice-view')).toBeNull();
    expect(screen.getByTestId('chat')).toBeInTheDocument();
  });
});

describe('the activity view during a reconnect', () => {
  const APPS: InstalledApp[] = [
    { id: 'vampire-village', name: 'Vampire Village', summary: null, minPlayers: 5, maxPlayers: 12, trustLevel: 'official', requiresVoice: true },
  ];
  const LIST_URL = `/api/servers/${SERVER}/channels/${VOICE}/activities`;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === LIST_URL) return Response.json({ activities: [{ id: 's-3', pluginId: 'vampire-village', status: 'running' }] });
        if (url === `/api/servers/${SERVER}/activities/s-3`) {
          return Response.json({
            activity: {
              id: 's-3',
              pluginId: 'vampire-village',
              status: 'running',
              state: {},
              createdBy: 'u-host',
              players: [],
              // The host left the game for good: anyone in the room may end it.
              host: { userId: 'u-host', inVoice: false, awaySince: null, transferAt: null, abandonAt: null, abandoned: true },
            },
          });
        }
        return Response.json({}, { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderActivity(connectionState: ConnectionState) {
    return render(
      <I18nProvider {...providerPropsFor('en')}>
        <LobbyVoiceContext.Provider value={makeVoice({ activeChannelId: VOICE, connectionState })}>
          <LobbyActivityView
            serverId={SERVER}
            channelId={VOICE}
            channelName="Lounge"
            apps={APPS}
            currentUserId="u-me"
            appSettingsHref={null}
          />
        </LobbyVoiceContext.Provider>
      </I18nProvider>
    );
  }

  it.each(RECONNECTING)('shows no "Join the voice channel" bar while LiveKit is %s', async (state) => {
    renderActivity(state);
    await screen.findByTestId('frame', {}, { timeout: 5000 });
    expect(screen.queryByTestId('activity-voice-join')).toBeNull();
    // Still a voice participant: End stays offered once the host abandoned.
    expect(screen.getByRole('button', { name: /End/ })).toBeInTheDocument();
  });

  it('shows the bar once the person is really out of the room', async () => {
    renderActivity(ConnectionState.Disconnected);
    expect(await screen.findByTestId('activity-voice-join', {}, { timeout: 5000 })).toHaveTextContent(
      'Join the voice channel to play'
    );
  });
});
