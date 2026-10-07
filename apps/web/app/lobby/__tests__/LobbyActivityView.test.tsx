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
  getRealtimeClient: () => ({ connect: () => {}, subscribe: () => () => {}, readyState: 1 }),
}));
vi.mock('@/lib/plugin-registry', () => ({ getPlugin: () => null }));
vi.mock('../PluginFrame', () => ({
  PluginFrameSurface: ({ appName, players }: { appName: string; players: Array<{ userId: string; name: string | null }> }) => (
    <div data-testid="frame">
      {appName}:{players.map((p) => `${p.userId}=${p.name ?? 'null'}`).join(',')}
    </div>
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
          canManageServer={false}
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
            canManageServer={false}
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
