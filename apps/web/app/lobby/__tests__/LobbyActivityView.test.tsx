// @vitest-environment happy-dom
/**
 * The activities surface in the centre column:
 *  - a marketplace (sandboxed) app is badged "Marketplace", with a hint
 *    that it runs sandboxed — it used to show no badge at all;
 *  - a refused start is said in the reader's language from its `code`,
 *    and `activity_exists` offers to open the running activity;
 *  - the status bar names the app as the page localised it ("Anket").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyActivityView, hostNoteKey } from '../LobbyActivityView';
import { ConnectionState, LobbyVoiceContext } from '../LobbyVoiceProvider';
import type { InstalledApp } from '../page';
import { makeVoice } from './voice-context';

vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ connect: () => {}, subscribe: () => () => {}, onReconnect: () => () => {}, readyState: 1 }),
}));
vi.mock('@/lib/plugin-registry', () => ({ getPlugin: () => null }));
vi.mock('../PluginFrame', () => ({
  PluginFrameSurface: ({
    appName,
    players,
    dispatch,
  }: {
    appName: string;
    players: Array<{ userId: string; name: string | null }>;
    dispatch: (action: Record<string, unknown>) => unknown;
  }) => (
    <>
      <div data-testid="frame">
        {appName}:{players.map((p) => `${p.userId}=${p.name ?? 'null'}`).join(',')}
      </div>
      <button type="button" onClick={() => void dispatch({ type: 'vote' })}>
        make a move
      </button>
    </>
  ),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const SERVER = 'srv-1';
const CHANNEL = 'v-1';
const LIST_URL = `/api/servers/${SERVER}/channels/${CHANNEL}/activities`;

const APPS: InstalledApp[] = [
  { id: 'poll', name: 'Anket', summary: 'Anonim anketler', minPlayers: null, maxPlayers: null, trustLevel: 'official' },
  { id: 'trivia-x', name: 'Trivia X', summary: null, minPlayers: 2, maxPlayers: 8, trustLevel: null, sandboxed: true },
];

let launchResponse: () => Response;

beforeEach(() => {
  launchResponse = () => Response.json({ activity: { id: 's-new' } }, { status: 201 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === LIST_URL && (init.method ?? 'GET') === 'GET') return Response.json({ activities: [] });
      if (url === LIST_URL && init.method === 'POST') return launchResponse();
      if (url === `/api/servers/${SERVER}/activities/s-1`) {
        return Response.json({
          activity: {
            id: 's-1',
            pluginId: 'poll',
            status: 'running',
            state: {},
            createdBy: 'u-host',
            players: [{ userId: 'u-host', name: 'Hilal', status: 'active', score: 0 }],
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

function renderView(locale = 'en', voice = makeVoice()) {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <LobbyActivityView
          serverId={SERVER}
          channelId={CHANNEL}
          channelName="Lounge"
          apps={APPS}
          currentUserId="u-me"
          appSettingsHref={null}
        />
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

const card = (name: RegExp) => screen.getByRole('button', { name });

describe('LobbyActivityView gallery', () => {
  it('badges an official app "Official" and a marketplace app "Marketplace" with a sandbox hint', async () => {
    renderView();
    await screen.findByRole('heading', { name: 'Start something together' }, { timeout: 5000 });

    expect(within(card(/Anket/)).getByText('Official')).toBeInTheDocument();
    const badge = within(card(/Trivia X/)).getByTestId('marketplace-badge');
    expect(badge).toHaveTextContent('Marketplace');
    expect(badge).toHaveAttribute('title', expect.stringMatching(/sandboxed/));
    // The hint is part of what a screen reader hears for the card.
    expect(card(/Trivia X/)).toHaveAccessibleName(expect.stringMatching(/runs sandboxed/));
  });

  it('says the marketplace badge in Turkish', async () => {
    renderView('tr');
    const badge = await screen.findByTestId('marketplace-badge', {}, { timeout: 5000 });
    expect(badge).toHaveTextContent('Market');
    expect(badge.getAttribute('title')).toMatch(/korumalı alanda/);
  });

  it('offers to open the running activity when the channel already has one', async () => {
    launchResponse = () =>
      Response.json({ error: 'An activity is already open', code: 'activity_exists', sessionId: 's-1' }, { status: 409 });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /Trivia X/ }, { timeout: 5000 }));

    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('An activity is already running in this channel.');
    expect(alert).not.toHaveTextContent('already open');
    await user.click(within(alert).getByRole('button', { name: 'Open the running activity' }));

    // The status bar names the app as the page localised it.
    const frame = await screen.findByTestId('frame', {}, { timeout: 5000 });
    expect(frame).toHaveTextContent('Anket:u-host=Hilal');
  });

  it('says other refusals in the reader’s language, never the server’s English', async () => {
    launchResponse = () => Response.json({ error: 'You must be in voice', code: 'voice_required' }, { status: 403 });
    const user = userEvent.setup();
    renderView('tr');
    await user.click(await screen.findByRole('button', { name: /Trivia X/ }, { timeout: 5000 }));
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('Oynamak için sesli kanala katıl.');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('names a late joiner on the bench from the voice room, and an unknown one as null', async () => {
    launchResponse = () =>
      Response.json({ error: 'exists', code: 'activity_exists', sessionId: 's-1' }, { status: 409 });
    const voice = makeVoice({
      activeChannelId: CHANNEL,
      participants: [
        { id: 'p1', identity: 'u-late', name: 'Zeynep', nameKnown: true, isLocal: false, isSpeaking: false, micEnabled: true, cameraEnabled: false, hasScreenShare: false },
        { id: 'p2', identity: 'u-new', name: 'Unknown member', nameKnown: false, isLocal: false, isSpeaking: false, micEnabled: true, cameraEnabled: false, hasScreenShare: false },
      ],
    });
    const user = userEvent.setup();
    renderView('en', voice);
    await user.click(await screen.findByRole('button', { name: /Trivia X/ }, { timeout: 5000 }));
    await user.click(await screen.findByRole('button', { name: 'Open the running activity' }, { timeout: 5000 }));
    await waitFor(
      () => expect(screen.getByTestId('frame')).toHaveTextContent('u-host=Hilal,u-late=Zeynep,u-new=null'),
      { timeout: 5000 }
    );
    expect(screen.getByTestId('frame')).not.toHaveTextContent('Unknown member');
  });
});

/**
 * A game played over voice whose host left the voice room: hosting moves
 * to someone in the room, and past the abandon time anyone in the room may
 * end it. The status rail says so, and shows End to who may use it.
 */
describe('LobbyActivityView host left', () => {
  const HOST = 'u-host';
  function serveSession(host: Record<string, unknown> | undefined, createdBy = HOST) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === LIST_URL) return Response.json({ activities: [{ id: 's-2', pluginId: 'poll', status: 'running' }] });
        if (url === `/api/servers/${SERVER}/activities/s-2`) {
          return Response.json({
            activity: { id: 's-2', pluginId: 'poll', status: 'running', state: {}, createdBy, players: [], ...(host ? { host } : {}) },
          });
        }
        return Response.json({}, { status: 404 });
      })
    );
  }
  const abandoned = { userId: HOST, inVoice: false, awaySince: new Date(Date.now() - 200_000).toISOString(), transferAt: null, abandonAt: new Date(Date.now() - 20_000).toISOString(), abandoned: true };
  const inRoom = makeVoice({ activeChannelId: CHANNEL, connectionState: ConnectionState.Connected });

  function renderSession(voice = makeVoice(), props: { canStartActivities?: boolean; currentUserId?: string } = {}, locale = 'en') {
    return render(
      <I18nProvider {...providerPropsFor(locale)}>
        <LobbyVoiceContext.Provider value={voice}>
          <LobbyActivityView
            serverId={SERVER}
            channelId={CHANNEL}
            channelName="Lounge"
            apps={APPS}
            currentUserId={props.currentUserId ?? 'u-me'}
            appSettingsHref={null}
            canStartActivities={props.canStartActivities ?? false}
          />
        </LobbyVoiceContext.Provider>
      </I18nProvider>
    );
  }

  it('shows End to a voice participant once the host has abandoned the game, with a note', async () => {
    serveSession(abandoned);
    renderSession(inRoom);
    const note = await screen.findByTestId('activity-host-note', {}, { timeout: 5000 });
    expect(note).toHaveTextContent('The host left. Anyone in the voice channel can end this activity.');
    expect(screen.getByRole('button', { name: 'End' })).toBeInTheDocument();
  });

  it('asks someone outside the voice channel to join it, and shows them no End', async () => {
    serveSession(abandoned);
    renderSession(makeVoice(), {}, 'tr');
    const note = await screen.findByTestId('activity-host-note', {}, { timeout: 5000 });
    expect(note).toHaveTextContent('Oyunu yöneten kişi ayrıldı. Bu etkinliği bitirmek için sesli kanala katıl.');
    expect(screen.queryByRole('button', { name: 'Bitir' })).toBeNull();
  });

  it('says a hand-over is coming while the host is away', async () => {
    serveSession({ ...abandoned, abandoned: false, transferAt: new Date(Date.now() + 30_000).toISOString(), abandonAt: new Date(Date.now() + 150_000).toISOString() });
    renderSession(inRoom);
    expect(await screen.findByTestId('activity-host-note', {}, { timeout: 5000 })).toHaveTextContent(
      'The host left the voice channel. Someone here takes over in a moment.'
    );
    // Not abandoned yet: a member without START_ACTIVITY cannot end it.
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
  });

  it('shows End to the host, and to members who may end any activity, with no note', async () => {
    serveSession({ userId: 'u-me', inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false }, 'u-me');
    renderSession(inRoom);
    expect(await screen.findByRole('button', { name: 'End' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('You are the host')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-host-note')).toBeNull();
  });

  it('shows End to a member with START_ACTIVITY on a game without a host view', async () => {
    serveSession(undefined);
    renderSession(makeVoice(), { canStartActivities: true });
    expect(await screen.findByRole('button', { name: 'End' }, { timeout: 5000 })).toBeInTheDocument();
  });
});

/**
 * `voice_required` is not a dead end (docs/ACTIVITY_INTEGRITY_AND_
 * RESILIENCE.md §3.2): in a game played over voice, a viewer outside the
 * channel's voice room gets a standing Join, and a move the server refused
 * for that reason has the same Join beside it. Spectating needs no voice:
 * the panel stays usable either way.
 */
describe('LobbyActivityView joining voice', () => {
  const VOICE_APPS: InstalledApp[] = [
    { id: 'vampire-village', name: 'Vampire Village', summary: null, minPlayers: 5, maxPlayers: 12, trustLevel: 'official', requiresVoice: true },
    { id: 'poll', name: 'Anket', summary: null, minPlayers: null, maxPlayers: null, trustLevel: 'official', requiresVoice: false },
  ];
  let actionResponse: () => Response;

  function serveGame(pluginId: string) {
    actionResponse = () => Response.json({ error: 'Join the voice channel', code: 'voice_required' }, { status: 403 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === LIST_URL) return Response.json({ activities: [{ id: 's-3', pluginId, status: 'running' }] });
        if (url === `/api/servers/${SERVER}/activities/s-3`) {
          return Response.json({
            activity: { id: 's-3', pluginId, status: 'running', state: {}, createdBy: 'u-host', players: [] },
          });
        }
        if (url === `/api/servers/${SERVER}/activities/s-3/actions`) return actionResponse();
        return Response.json({}, { status: 404 });
      })
    );
  }

  function renderGame(voice = makeVoice(), locale = 'en') {
    return render(
      <I18nProvider {...providerPropsFor(locale)}>
        <LobbyVoiceContext.Provider value={voice}>
          <LobbyActivityView
            serverId={SERVER}
            channelId={CHANNEL}
            channelName="Lounge"
            apps={VOICE_APPS}
            currentUserId="u-me"
            appSettingsHref={null}
          />
        </LobbyVoiceContext.Provider>
      </I18nProvider>
    );
  }

  it('shows a standing Join to a viewer outside the voice room, and joins this channel', async () => {
    serveGame('vampire-village');
    const voice = makeVoice();
    const user = userEvent.setup();
    renderGame(voice);
    const bar = await screen.findByTestId('activity-voice-join', {}, { timeout: 5000 });
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveTextContent('Join the voice channel to play');
    // The game stays on screen: spectating needs no voice.
    expect(screen.getByTestId('frame')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Join #Lounge' }));
    expect(voice.connectToChannel).toHaveBeenCalledWith(CHANNEL);
  });

  it('says it in Turkish', async () => {
    serveGame('vampire-village');
    renderGame(makeVoice(), 'tr');
    const bar = await screen.findByTestId('activity-voice-join', {}, { timeout: 5000 });
    expect(bar).toHaveTextContent('Oynamak için sesli kanala katıl');
    expect(within(bar).getByRole('button', { name: '#Lounge kanalına katıl' })).toHaveTextContent('Katıl');
  });

  it('shows nothing to a viewer in the voice room, or for a game that needs no voice', async () => {
    serveGame('vampire-village');
    const { unmount } = renderGame(makeVoice({ activeChannelId: CHANNEL, connectionState: ConnectionState.Connected }));
    await screen.findByTestId('frame', {}, { timeout: 5000 });
    expect(screen.queryByTestId('activity-voice-join')).toBeNull();
    unmount();

    serveGame('poll');
    renderGame();
    await screen.findByTestId('frame', {}, { timeout: 5000 });
    expect(screen.queryByTestId('activity-voice-join')).toBeNull();
  });

  it('says it is joining while the join is under way', async () => {
    serveGame('vampire-village');
    renderGame(makeVoice({ activeChannelId: CHANNEL, connecting: true }));
    const bar = await screen.findByTestId('activity-voice-join', {}, { timeout: 5000 });
    expect(within(bar).getByRole('button', { name: 'Joining…' })).toBeDisabled();
  });

  it('puts Join beside a move refused with voice_required', async () => {
    serveGame('vampire-village');
    const voice = makeVoice();
    const user = userEvent.setup();
    renderGame(voice);
    await user.click(await screen.findByRole('button', { name: 'make a move' }, { timeout: 5000 }));
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('Join the voice channel to play.');
    const beside = alert.parentElement!;
    await user.click(within(beside).getByRole('button', { name: 'Join #Lounge' }));
    expect(voice.connectToChannel).toHaveBeenCalledWith(CHANNEL);
  });

  it('puts no Join beside any other refusal', async () => {
    serveGame('poll');
    actionResponse = () => Response.json({ error: 'host only', code: 'not_host' }, { status: 403 });
    const user = userEvent.setup();
    renderGame();
    await user.click(await screen.findByRole('button', { name: 'make a move' }, { timeout: 5000 }));
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('Only the host can do that.');
    expect(within(alert.parentElement!).queryByRole('button')).toBeNull();
  });

  it('offers the way back after a drop instead, when it is for this channel', async () => {
    serveGame('vampire-village');
    const voice = makeVoice({
      voiceResume: { channelId: CHANNEL, channelName: 'Lounge' },
      resumeVoice: vi.fn(async () => {}),
      dismissVoiceResume: vi.fn(),
    });
    const user = userEvent.setup();
    renderGame(voice);
    const strip = await screen.findByTestId('voice-resume-strip', {}, { timeout: 5000 });
    expect(strip).toHaveAttribute('data-placement', 'activity');
    expect(strip).toHaveTextContent('You dropped out of voice.');
    await screen.findByTestId('frame', {}, { timeout: 5000 });
    // One strip, not two.
    expect(screen.queryByTestId('activity-voice-join')).toBeNull();
    await user.click(within(strip).getByRole('button', { name: 'Back to #Lounge' }));
    expect(voice.resumeVoice).toHaveBeenCalled();
  });
});

describe('hostNoteKey', () => {
  const base = { userId: 'h', inVoice: false, awaySince: null, transferAt: null, abandonAt: null, abandoned: false };
  it('says nothing to the host, or while the host is in the room', () => {
    expect(hostNoteKey({ ...base, abandoned: true }, { isHost: true, inVoiceRoom: true })).toBeNull();
    expect(hostNoteKey({ ...base, inVoice: true }, { isHost: false, inVoiceRoom: true })).toBeNull();
    expect(hostNoteKey(null, { isHost: false, inVoiceRoom: true })).toBeNull();
  });
  it('picks the note for each stage', () => {
    const viewer = { isHost: false, inVoiceRoom: true };
    expect(hostNoteKey({ ...base, transferAt: 'x' }, viewer)).toBe('lobbyMain.activities.hostAwayTransfer');
    expect(hostNoteKey({ ...base, abandonAt: 'x' }, viewer)).toBe('lobbyMain.activities.hostAwayWaiting');
    expect(hostNoteKey({ ...base, abandoned: true }, viewer)).toBe('lobbyMain.activities.hostLeft');
    expect(hostNoteKey({ ...base, abandoned: true }, { isHost: false, inVoiceRoom: false })).toBe('lobbyMain.activities.hostLeftJoin');
  });
});
