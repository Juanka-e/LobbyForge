// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { __clearMemberProfileCacheForTests, type MemberProfileResponse } from '@/lib/member-profile';
import { LobbyVoiceContext, type LobbyVoiceContextValue } from '../LobbyVoiceProvider';
import { makeVoice, participant } from './voice-context';

/**
 * The lobby's one profile card (docs/PROFILES.md): every place that shows a
 * person opens it — the member list (with the status the member CHOSE),
 * a chat author's avatar and name, the voice roster (left click; the
 * moderator menu stays on right-click and ⋮), the DM header, and your own
 * account block. One card at a time; another anchor switches it; the
 * profile is fetched once per (server, user); "Message @name" opens the DM
 * in the centre column; the full profile has tabs.
 */

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ subscribe: () => () => {}, connect: () => {} }),
}));

const SERVER = 'srv-1';
const ME = '00000000-0000-4000-8000-000000000001';
const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b2';

const MEMBERS = [
  { id: ME, name: 'Me', status: 'online' as const, presence: 'online' as const },
  {
    id: ALICE,
    name: 'Alice',
    status: 'online' as const,
    presence: 'dnd' as const,
    avatarUrl: `/api/users/${ALICE}/avatar?v=0123456789ab`,
    bio: 'seed bio',
  },
  { id: BOB, name: 'Bob', status: 'in-voice' as const, presence: 'idle' as const },
];

function profileFor(userId: string, overrides: Partial<MemberProfileResponse['viewerCan']> = {}): MemberProfileResponse {
  const name = userId === ALICE ? 'Alice' : userId === BOB ? 'Bob' : 'Me';
  return {
    profile: {
      userId,
      displayName: name,
      globalDisplayName: name,
      nickname: null,
      avatarUrl: null,
      bannerUrl: null,
      isGuest: false,
      statusText: null,
      bio: `${name} bio`,
      presence: 'online',
      inVoice: false,
      roles: rolesFor[userId] ?? [],
      memberSince: '2026-02-03T04:05:06.000Z',
      accountCreatedAt: '2025-01-02T03:04:05.000Z',
      mutualServers: [
        { id: SERVER, name: 'Castle Club', iconUrl: null },
        { id: 'srv-2', name: 'Elsewhere', iconUrl: null },
      ],
      mutualServerCount: 2,
      blockedByMe: false,
      limited: false,
      isOwner: false,
      timedOutUntil: null,
    },
    viewerCan: {
      isSelf: userId === ME,
      message: userId !== ME,
      kick: false,
      ban: false,
      timeout: false,
      serverMute: false,
      manageRoles: false,
      assignableRoles: [],
      removableRoleIds: [],
      currentRoleIds: [],
      ...overrides,
    },
  };
}

/** The presence feed the member list polls: Alice chose Do Not Disturb, Bob is idle in a voice channel. */
const PRESENCES = () => [
  { userId: ME, channelId: 'ch-text', status: 'online', lastSeen: Date.now() },
  { userId: ALICE, channelId: 'ch-text', status: 'dnd', lastSeen: Date.now() },
  { userId: BOB, channelId: 'ch-voice', status: 'idle', lastSeen: Date.now() },
];

let fetchMock: ReturnType<typeof vi.fn>;
let canFor: Record<string, Partial<MemberProfileResponse['viewerCan']>> = {};
/** What the profile API answers as each member's roles (without @everyone). */
let rolesFor: Record<string, MemberProfileResponse['profile']['roles']> = {};

beforeEach(() => {
  __clearMemberProfileCacheForTests();
  canFor = {};
  rolesFor = {};
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const profile = url.match(/\/members\/([^/]+)\/profile$/);
    if (profile) return Response.json(profileFor(profile[1]!, canFor[profile[1]!]));
    if (url === '/api/dm' && init?.method === 'POST') return Response.json({ channel: { id: 'dm-1' } });
    if (url === '/api/dm/dm-1/messages' && init?.method === 'POST') return Response.json({ message: { id: 'm1' } }, { status: 201 });
    if (url.includes('/api/presence')) return Response.json({ presences: PRESENCES() });
    if (url.includes('/api/settings/me/blocks')) return Response.json({ blocks: [] });
    if (url.match(/\/members\/[^/]+$/) && init?.method === 'DELETE') return Response.json({ success: true });
    if (url.includes('/messages')) return Response.json({ messages: [] });
    if (url.includes('/typing')) return Response.json({ typers: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderLobby(children: ReactNode, voice: LobbyVoiceContextValue = makeVoice({ serverId: SERVER })) {
  const { ProfileCardProvider } = await import('../ProfileCardProvider');
  const utils = render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyVoiceContext.Provider value={voice}>
        <ProfileCardProvider serverId={SERVER} serverName="Castle Club" currentUserId={ME} members={MEMBERS}>
          {children}
        </ProfileCardProvider>
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
  return { ...utils, voice };
}

const profileCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/profile'));

/** A row of the member list (the card has buttons naming the member too). */
const row = (name: RegExp) => within(screen.getByRole('complementary')).getByRole('button', { name });

describe('member list', () => {
  it('opens the card with the status the member chose — Do Not Disturb — not the voice state', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    await renderLobby(<LobbyMembersClient serverId={SERVER} initialMembers={MEMBERS} voiceChannelIds={['ch-voice']} currentUserId={ME} />);
    fireEvent.click(row(/Alice/));
    const card = screen.getByRole('dialog', { name: 'Alice profile' });
    expect(within(card).getByRole('img', { name: 'Do Not Disturb' })).toBeInTheDocument();
    // The seed shows at once; the API fills in.
    expect(within(card).getByText('seed bio')).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByText('Alice bio')).toBeInTheDocument());
    expect(within(screen.getByRole('complementary')).getByRole('button', { name: /Alice/, expanded: true })).toBeInTheDocument();
  });

  it('one card at a time: another row switches it, the same row closes it, and each profile is fetched once', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    await renderLobby(<LobbyMembersClient serverId={SERVER} initialMembers={MEMBERS} voiceChannelIds={['ch-voice']} currentUserId={ME} />);
    fireEvent.click(row(/Alice/));
    await waitFor(() => expect(screen.getByText('Alice bio')).toBeInTheDocument());
    fireEvent.mouseDown(row(/Bob/));
    fireEvent.click(row(/Bob/));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Bob profile' })).toBeInTheDocument();
    // Bob is in voice: shown apart from his chosen status (Idle).
    expect(within(screen.getByRole('dialog')).getByText('In voice')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: 'Idle' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Bob bio')).toBeInTheDocument());
    fireEvent.click(row(/Bob/));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Back to Alice: served from the cache.
    fireEvent.click(row(/Alice/));
    expect(screen.getByText('Alice bio')).toBeInTheDocument();
    expect(profileCalls().map(([url]) => String(url))).toEqual([
      `/api/servers/${SERVER}/members/${ALICE}/profile`,
      `/api/servers/${SERVER}/members/${BOB}/profile`,
    ]);
  });

  it('a click elsewhere closes the card', async () => {
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    await renderLobby(
      <>
        <p>elsewhere</p>
        <LobbyMembersClient serverId={SERVER} initialMembers={MEMBERS} voiceChannelIds={['ch-voice']} currentUserId={ME} />
      </>
    );
    fireEvent.click(row(/Alice/));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a member kicked through the card leaves the list, with a notice', async () => {
    canFor[ALICE] = { kick: true };
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    await renderLobby(<LobbyMembersClient serverId={SERVER} initialMembers={MEMBERS} voiceChannelIds={['ch-voice']} currentUserId={ME} />);
    fireEvent.click(row(/Alice/));
    await waitFor(() => expect(screen.getByText('Alice bio')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Alice' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Kick/ }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Kick' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(screen.getByRole('complementary')).queryByRole('button', { name: /Alice/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Alice was kicked.');
  });
});

describe('a role change made in the card', () => {
  const MODS = { id: 'r-mods', name: 'Mods', color: '#ff8800', icon: 'shield', position: 10 };

  // The A-to-Z run: the card showed the new role at once, but the member
  // list's role groups only followed on the next page load.
  it('regroups the member list at once, with the role’s heading and colour', async () => {
    canFor[ALICE] = { manageRoles: true, assignableRoles: [MODS], currentRoleIds: ['r-everyone'] };
    const puts: unknown[] = [];
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/members/${ALICE}/role`) && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        rolesFor[ALICE] = [{ ...MODS, displaySeparately: true }];
        canFor[ALICE] = { manageRoles: true, assignableRoles: [], currentRoleIds: ['r-everyone', MODS.id], removableRoleIds: [MODS.id] };
        return Response.json({ membership: { roleIds: ['r-everyone', MODS.id] } });
      }
      return base(input, init);
    });
    const { LobbyMembersClient } = await import('../LobbyMembersClient');
    await renderLobby(<LobbyMembersClient serverId={SERVER} initialMembers={MEMBERS} voiceChannelIds={['ch-voice']} currentUserId={ME} />);
    const list = screen.getByRole('complementary');
    await waitFor(() => expect(within(list).getByText(/^Online/)).toBeInTheDocument());
    expect(within(list).queryByText('Mods - 1')).toBeNull();

    fireEvent.click(row(/Alice/));
    await waitFor(() => expect(screen.getByText('Alice bio')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    fireEvent.click(screen.getByRole('option', { name: /Mods/ }));

    await waitFor(() => expect(within(list).getByText('Mods - 1')).toBeInTheDocument());
    expect(puts).toEqual([{ roleIds: ['r-everyone', MODS.id] }]);
    // Alice sits under the role's heading, in its colour.
    const group = within(list).getByText('Mods - 1').closest('div')!;
    expect(within(group).getByRole('button', { name: /Alice/ })).toBeInTheDocument();
    expect(within(group).getByText('Alice')).toHaveStyle({ color: '#ff8800' });
  });
});

describe('Message @name', () => {
  it('opens or creates the DM, sends the message there, then shows the conversation in the centre column', async () => {
    const openDm = vi.fn();
    const { ProfileTrigger } = await import('../ProfileCardProvider');
    await renderLobby(<ProfileTrigger userId={ALICE}>Alice</ProfileTrigger>, makeVoice({ serverId: SERVER, openDm }));
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect(screen.getByText('Alice bio')).toBeInTheDocument());
    const box = screen.getByRole('textbox', { name: 'Message @Alice' });
    fireEvent.change(box, { target: { value: 'hi Alice' } });
    await act(async () => {
      fireEvent.submit(box.closest('form')!);
    });
    const dmCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/dm'));
    expect(dmCalls.map(([url, init]) => [String(url), (init as RequestInit).method, JSON.parse(String((init as RequestInit).body))])).toEqual([
      ['/api/dm', 'POST', { recipientUserId: ALICE }],
      ['/api/dm/dm-1/messages', 'POST', { content: 'hi Alice' }],
    ]);
    expect(openDm).toHaveBeenCalledWith({ channelId: 'dm-1', name: 'Alice', avatarUrl: null, otherUserId: ALICE });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('full profile', () => {
  it('View full profile opens the modal with About and Mutual communities tabs', async () => {
    const { ProfileTrigger } = await import('../ProfileCardProvider');
    await renderLobby(<ProfileTrigger userId={ALICE}>Alice</ProfileTrigger>);
    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));
    await waitFor(() => expect(screen.getByText('Alice bio')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'View full profile' }));
    const modal = screen.getByRole('dialog', { name: 'Alice profile' });
    expect(modal).toHaveAttribute('aria-modal', 'true');
    const about = within(modal).getByRole('tab', { name: 'About' });
    expect(about).toHaveAttribute('aria-selected', 'true');
    expect(within(modal).getByRole('tabpanel')).toHaveTextContent('Alice bio');
    fireEvent.keyDown(about, { key: 'ArrowRight' });
    const mutual = within(modal).getByRole('tab', { name: '2 mutual communities' });
    expect(mutual).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(mutual);
    const links = within(within(modal).getByRole('tabpanel')).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/lobby?server=srv-1', '/lobby?server=srv-2']);
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(within(modal).getByText('This community')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('every place that shows a person', () => {
  it('chat: the author’s name and avatar both open the card; bots do not', async () => {
    const { LobbyLiveRoster } = await import('../LobbyLiveRoster');
    await renderLobby(
      <LobbyLiveRoster
        data={{
          serverId: SERVER,
          channelId: 'ch-1',
          channelName: 'general',
          currentUserId: ME,
          voiceChannelId: null,
          initialMessages: [
            { id: 'm1', authorId: ALICE, author: 'Alice', timestamp: 'now', createdAt: new Date().toISOString(), body: 'hello' },
            {
              id: 'm2',
              authorId: null,
              author: 'Greeter',
              timestamp: 'now',
              createdAt: new Date().toISOString(),
              body: 'welcome',
              bot: { id: 'b1', name: 'Greeter', type: 'welcome' },
            },
          ],
          knownNames: { [ALICE]: 'Alice' },
          canManageMessages: false,
        }}
      />
    );
    const author = screen.getByTestId('chat-author');
    expect(author.tagName).toBe('BUTTON');
    fireEvent.click(author);
    expect(screen.getByRole('dialog', { name: 'Alice profile' })).toBeInTheDocument();
    fireEvent.click(author);
    const avatar = screen.getByTestId('chat-avatar');
    // The photo the member list knows, out of the tab order (the name is the keyboard path).
    expect(avatar.querySelector('img')).toHaveAttribute('src', `/api/users/${ALICE}/avatar?v=0123456789ab`);
    expect(avatar).toHaveAttribute('tabindex', '-1');
    expect(avatar).toHaveAttribute('data-chat-avatar');
    fireEvent.click(avatar);
    expect(screen.getByRole('dialog', { name: 'Alice profile' })).toBeInTheDocument();
    expect(screen.getAllByTestId('chat-author')).toHaveLength(1);
  });

  it('a card opened from chat shows the API’s status and voice state, not the stale page render’s', async () => {
    const { ProfileTrigger } = await import('../ProfileCardProvider');
    // The page rendered Bob idle and in voice; the API says online, not in voice.
    await renderLobby(<ProfileTrigger userId={BOB}>Bob</ProfileTrigger>);
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    const card = screen.getByRole('dialog', { name: 'Bob profile' });
    await waitFor(() => expect(within(card).getByRole('img', { name: 'Online' })).toBeInTheDocument());
    expect(within(card).queryByText('In voice')).toBeNull();
    expect(within(card).queryByRole('img', { name: 'Idle' })).toBeNull();
  });

  it('voice roster: a left click opens the card; right-click still opens the moderator menu', async () => {
    const { LobbyVoiceChannels } = await import('../LobbyVoiceChannels');
    const voice = makeVoice({
      serverId: SERVER,
      activeChannelId: 'ch-lounge',
      participants: [participant(ME, 'Me', { isLocal: true }), participant(ALICE, 'Alice')],
    });
    await renderLobby(
      <LobbyVoiceChannels
        channels={[{ id: 'ch-lounge', name: 'Lounge', category: 'voice' }]}
        currentUserId={ME}
        canMuteMembers
        voiceModerationTargetIds={[ALICE]}
      />,
      voice
    );
    const row = screen.getByRole('button', { name: 'A Alice' });
    fireEvent.click(row);
    const card = screen.getByRole('dialog', { name: 'Alice profile' });
    expect(within(card).getByText('In voice')).toBeInTheDocument();
    fireEvent.contextMenu(row.closest('li')!);
    expect(screen.getByRole('menu', { name: 'Voice actions for Alice' })).toBeInTheDocument();
  });

  it('the DM header opens the other person’s card', async () => {
    const { LobbyDmView } = await import('../LobbyDmView');
    await renderLobby(
      <LobbyDmView dm={{ channelId: 'dm-1', name: 'Alice', avatarUrl: null, otherUserId: ALICE }} currentUserId={ME} currentDisplayName="Me" />
    );
    fireEvent.click(screen.getByTestId('dm-header-profile'));
    expect(screen.getByRole('dialog', { name: 'Alice profile' })).toBeInTheDocument();
  });

  it('your account block: the avatar opens your own card (Edit profile, status); the name keeps the status menu', async () => {
    const setPresenceStatus = vi.fn();
    const { LobbyPresenceMenu } = await import('../LobbyPresenceMenu');
    await renderLobby(
      <LobbyPresenceMenu displayName="Me" hasUser status="online" onChange={() => {}} voiceLabel={null} />,
      makeVoice({ serverId: SERVER, presenceStatus: 'online', setPresenceStatus })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Your profile' }));
    const card = screen.getByRole('dialog', { name: 'Me profile' });
    expect(within(card).getByRole('link', { name: /Edit profile/ })).toHaveAttribute('href', '/settings/profile');
    expect(within(card).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(card).getByRole('radio', { name: 'Do Not Disturb' }));
    expect(setPresenceStatus).toHaveBeenCalledWith('dnd');
    fireEvent.click(within(card).getByRole('button', { name: 'Close profile' }));
    fireEvent.click(screen.getByRole('button', { name: /^Me/ }));
    expect(screen.getByRole('menu', { name: 'Set your status' })).toBeInTheDocument();
  });
});
