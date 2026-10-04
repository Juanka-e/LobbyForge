// @vitest-environment happy-dom
/**
 * The voice roster's moderator "Disconnect from voice": offered only with
 * MUTE_MEMBERS, only for members the viewer outranks (never themselves or
 * the owner), confirm-free, keyboard reachable, and a refusal is said in
 * the viewer's language from the route's `code`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectionState } from 'livekit-client';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyVoiceChannels, disconnectErrorMessage, type LobbyVoiceChannelsProps } from '../LobbyVoiceChannels';
import { LobbyVoiceContext, type LobbyVoiceContextValue, type LobbyVoiceParticipant } from '../LobbyVoiceProvider';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const SERVER_ID = 'srv-1';
const LOUNGE = 'ch-lounge';
const GAMES = 'ch-games';
const ME = 'u-me';
const OWNER = 'u-owner';
const MALLORY = 'u-mallory';
const PEER = 'u-peer';

function participant(identity: string, name: string, overrides: Partial<LobbyVoiceParticipant> = {}): LobbyVoiceParticipant {
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

const ROOM = [
  participant(ME, 'Me', { isLocal: true }),
  participant(OWNER, 'Olivia'),
  participant(MALLORY, 'Mallory'),
  participant(PEER, 'Peter'),
];

function makeVoice(overrides: Partial<LobbyVoiceContextValue> = {}): LobbyVoiceContextValue {
  return {
    serverId: SERVER_ID,
    livekitUrl: 'ws://localhost:7880',
    activeChannelId: LOUNGE,
    connectionState: ConnectionState.Connected,
    connecting: false,
    error: null,
    micEnabled: true,
    cameraEnabled: false,
    screenShareEnabled: false,
    screenSharePolicy: { maxHeight: 1080, maxFps: 30 },
    screenSharePreference: { quality: 'high', fps: '30' },
    deafenEnabled: false,
    participants: ROOM,
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

let presences: Array<{ userId: string; channelId: string }> = [];
let disconnectResponse: () => Response = () => new Response(JSON.stringify({ success: true }), { status: 200 });
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
  const url = String(input);
  if (url.startsWith('/api/presence')) return new Response(JSON.stringify({ presences }), { status: 200 });
  if (url.endsWith('/voice/disconnect')) return disconnectResponse();
  return new Response('{}', { status: 404 });
});

function renderRoster(props: Partial<LobbyVoiceChannelsProps> = {}, voice = makeVoice(), locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyVoiceChannels
          channels={[
            { id: LOUNGE, name: 'Main Lounge', category: 'voice' },
            { id: GAMES, name: 'Games', category: 'voice' },
          ]}
          currentUserId={ME}
          canMuteMembers
          voiceModerationTargetIds={[MALLORY]}
          {...props}
        />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

const menuButton = (name: string) => screen.queryByRole('button', { name: `Voice actions for ${name}` });

beforeEach(() => {
  presences = [];
  disconnectResponse = () => new Response(JSON.stringify({ success: true }), { status: 200 });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function disconnectCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/voice/disconnect'));
}

describe('LobbyVoiceChannels — who gets "Disconnect from voice"', () => {
  it('offers it for a member the viewer outranks, and for nobody else', () => {
    renderRoster();
    expect(menuButton('Mallory')).toBeInTheDocument();
    // Not yourself, not the owner, not someone at or above your rank.
    expect(menuButton('Me')).toBeNull();
    expect(menuButton('Olivia')).toBeNull();
    expect(menuButton('Peter')).toBeNull();
  });

  it('never offers it for yourself or the owner, even if the page listed them', () => {
    renderRoster({ voiceModerationTargetIds: [ME, MALLORY] });
    expect(menuButton('Me')).toBeNull();
    expect(menuButton('Mallory')).toBeInTheDocument();
  });

  it('offers nothing without MUTE_MEMBERS', () => {
    renderRoster({ canMuteMembers: false });
    expect(screen.queryByRole('button', { name: /^Voice actions for/ })).toBeNull();
  });

  it('also works for someone in another voice channel the moderator is not in', async () => {
    presences = [{ userId: MALLORY, channelId: GAMES }];
    renderRoster(
      { initialVoiceUsersByChannel: { [GAMES]: [{ id: MALLORY, name: 'Mallory' }] } },
      makeVoice({ participants: [], activeChannelId: null, connectionState: ConnectionState.Disconnected })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Voice actions for Mallory' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect from voice' }));
    await waitFor(() => expect(disconnectCalls()).toHaveLength(1));
    expect(String(disconnectCalls()[0]![0])).toBe(`/api/servers/${SERVER_ID}/channels/${GAMES}/members/${MALLORY}/voice/disconnect`);
  });
});

describe('LobbyVoiceChannels — the action', () => {
  it('calls the route for that channel and member without a confirmation step', async () => {
    renderRoster();
    fireEvent.click(menuButton('Mallory')!);
    const menu = screen.getByRole('menu', { name: 'Voice actions for Mallory' });
    const item = within(menu).getByRole('menuitem', { name: 'Disconnect from voice' });
    fireEvent.click(item);
    await waitFor(() => expect(disconnectCalls()).toHaveLength(1));
    const [url, init] = disconnectCalls()[0]!;
    expect(String(url)).toBe(`/api/servers/${SERVER_ID}/channels/${LOUNGE}/members/${MALLORY}/voice/disconnect`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    // The menu closes and no error shows.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is keyboard reachable: opening focuses the item, Escape closes and returns focus', () => {
    renderRoster();
    const trigger = menuButton('Mallory')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const item = screen.getByRole('menuitem', { name: 'Disconnect from voice' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the first item only once the menu is visible (a hidden element cannot take focus in a browser)', () => {
    // jsdom lets a `visibility: hidden` element take focus; a browser does
    // not, and then Escape/Tab (handled on the menu) never arrive. Record
    // the menu's visibility at the moment its item is focused.
    const visibilityAtFocus: string[] = [];
    const originalFocus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.getAttribute('role') === 'menuitem') {
        visibilityAtFocus.push((this.closest('[role="menu"]') as HTMLElement | null)?.style.visibility ?? 'missing');
      }
      return originalFocus.call(this, options);
    });
    try {
      renderRoster();
      fireEvent.click(menuButton('Mallory')!);
      expect(visibilityAtFocus.length).toBeGreaterThan(0);
      expect(visibilityAtFocus.every((value) => value === 'visible')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('renders the menu on <body>, beside its row, so a section’s fade-in cannot trap it', () => {
    const { container } = renderRoster();
    const trigger = menuButton('Mallory')!;
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Voice actions for Mallory' });
    // Outside the sidebar's stacking contexts.
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.visibility).toBe('visible');
    // A click inside the portalled menu is not "outside".
    fireEvent.mouseDown(menu);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Tab leaves the menu from its row: focus goes back to the button first.
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Disconnect from voice' }), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens on right-click, like Discord', () => {
    renderRoster();
    fireEvent.contextMenu(screen.getByText('Mallory'));
    expect(screen.getByRole('menu', { name: 'Voice actions for Mallory' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('says a refusal in the viewer’s language, from the route’s code', async () => {
    disconnectResponse = () =>
      new Response(JSON.stringify({ error: 'You can only disconnect from voice members below your highest role', code: 'insufficient_rank' }), {
        status: 403,
      });
    renderRoster({}, makeVoice(), 'tr');
    fireEvent.click(screen.getByRole('button', { name: 'Mallory için ses işlemleri' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ses bağlantısını kes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Yalnızca en yüksek rolü seninkinden aşağıda olan üyelerin ses bağlantısını kesebilirsin.'
    );
  });

  it('tells the moderator when the member already left the channel', async () => {
    disconnectResponse = () => new Response(JSON.stringify({ error: 'x', code: 'not_in_voice' }), { status: 404 });
    renderRoster();
    fireEvent.click(menuButton('Mallory')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect from voice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mallory is no longer in that voice channel.');
  });

  it('reports a network failure', async () => {
    disconnectResponse = () => {
      throw new TypeError('Failed to fetch');
    };
    renderRoster();
    fireEvent.click(menuButton('Mallory')!);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect from voice' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not disconnect Mallory from voice. Check your connection.');
  });
});

describe('disconnectErrorMessage', () => {
  it.each([
    ['forbidden', 403, 'lobbyMain.voice.disconnectError.forbidden'],
    ['insufficient_rank', 403, 'lobbyMain.voice.disconnectError.insufficientRank'],
    ['target_is_owner', 403, 'lobbyMain.voice.disconnectError.owner'],
    ['self_action', 400, 'lobbyMain.voice.disconnectError.self'],
    ['not_in_voice', 404, 'lobbyMain.voice.disconnectError.notInVoice'],
    ['target_not_member', 404, 'lobbyMain.voice.disconnectError.notMember'],
    ['voice_unavailable', 503, 'lobbyMain.voice.disconnectError.unavailable'],
    [undefined, 429, 'lobbyMain.voice.disconnectError.rateLimited'],
    [undefined, 403, 'lobbyMain.voice.disconnectError.forbidden'],
    [undefined, 500, 'lobbyMain.voice.disconnectError.generic'],
  ])('%s / %i → %s', (code, status, key) => {
    expect(disconnectErrorMessage(status, code, 'Mallory').key).toBe(key);
  });
});
