// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { placeProfileCard, UserProfilePopover } from '@/components/modals/UserProfilePopover';
import type { MemberProfileResponse, ProfileSeed } from '@/lib/member-profile';

/**
 * The profile card (docs/PROFILES.md): opens at once with the lobby's seed,
 * fills in from the API, shows the status the member CHOSE (idle, do not
 * disturb) apart from "in voice", the image viewer, "Message @name", the
 * "⋯" menu with only the moderation `viewerCan` allows (refusals inline),
 * role editing through the role route, and the dialog focus contract.
 */

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const SERVER = 'srv-1';
const ALICE = '00000000-0000-4000-8000-0000000000a1';

const seed: ProfileSeed = {
  userId: ALICE,
  displayName: 'Ace',
  globalDisplayName: 'Alice Global',
  nickname: 'Ace',
  avatarUrl: `/api/users/${ALICE}/avatar?v=0123456789ab`,
  bannerUrl: null,
  isGuest: false,
  statusText: 'Building a castle',
  bio: 'Hello from the seed',
  roles: [{ id: 'r-vet', name: 'Veteran', color: '#22aa66', icon: null, position: 5 }],
  presence: 'dnd',
};

function response(overrides: Partial<MemberProfileResponse['profile']> = {}, can: Partial<MemberProfileResponse['viewerCan']> = {}): MemberProfileResponse {
  return {
    profile: {
      userId: ALICE,
      displayName: 'Ace',
      globalDisplayName: 'Alice Global',
      nickname: 'Ace',
      avatarUrl: `/api/users/${ALICE}/avatar?v=0123456789ab`,
      bannerUrl: `/api/users/${ALICE}/banner?v=abcdefabcdef`,
      isGuest: false,
      statusText: 'Building a castle',
      bio: 'Hello from the API',
      presence: 'idle',
      inVoice: false,
      roles: [{ id: 'r-vet', name: 'Veteran', color: '#22aa66', icon: null, position: 5 }],
      memberSince: '2026-02-03T04:05:06.000Z',
      accountCreatedAt: '2025-01-02T03:04:05.000Z',
      mutualServers: [
        { id: SERVER, name: 'Here', iconUrl: null },
        { id: 'srv-2', name: 'Elsewhere', iconUrl: null },
      ],
      mutualServerCount: 2,
      blockedByMe: false,
      limited: false,
      isOwner: false,
      timedOutUntil: null,
      ...overrides,
    },
    viewerCan: {
      isSelf: false,
      message: true,
      kick: false,
      ban: false,
      timeout: false,
      serverMute: false,
      manageRoles: false,
      assignableRoles: [],
      removableRoleIds: [],
      currentRoleIds: [],
      ...can,
    },
  };
}

const MODERATOR_CAN = {
  kick: true,
  ban: true,
  timeout: true,
  manageRoles: true,
  assignableRoles: [{ id: 'r-helper', name: 'Helper', color: '#3366ff', icon: null, position: 3 }],
  removableRoleIds: ['r-vet'],
  currentRoleIds: ['r-vet', 'r-everyone'],
};

type CardProps = Partial<ComponentProps<typeof UserProfilePopover>>;

function Harness(props: CardProps & { start?: boolean }) {
  const [open, setOpen] = useState(props.start ?? true);
  return (
    <I18nProvider {...providerPropsFor('en')}>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <UserProfilePopover
        open={open}
        onClose={() => setOpen(false)}
        user={seed}
        serverId={SERVER}
        serverName="Castle Club"
        {...props}
      />
    </I18nProvider>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function card() {
  return screen.getByRole('dialog', { name: 'Ace profile' });
}

describe('opening and filling in', () => {
  it('opens at once with the seed and skeletons, then shows the API answer', () => {
    const { rerender } = render(<Harness loading />);
    expect(within(card()).getByRole('heading', { name: 'Ace' })).toBeInTheDocument();
    expect(within(card()).getByText('Alice Global')).toBeInTheDocument();
    expect(within(card()).getByText('Hello from the seed')).toBeInTheDocument();
    // Member since is still loading.
    expect(within(card()).getByRole('heading', { name: 'Member since' })).toBeInTheDocument();
    expect(within(card()).queryByText('Feb 3, 2026')).toBeNull();

    rerender(<Harness profile={response()} />);
    expect(within(card()).getByText('Hello from the API')).toBeInTheDocument();
    expect(within(card()).getByText('Feb 3, 2026')).toBeInTheDocument();
    expect(within(card()).getByText('Jan 2, 2025')).toBeInTheDocument();
    expect(within(card()).getByText('2 mutual communities')).toBeInTheDocument();
    expect(within(card()).getByText('Building a castle')).toBeInTheDocument();
  });

  it('dates follow the viewer’s language', () => {
    render(
      <I18nProvider {...providerPropsFor('tr')}>
        <UserProfilePopover open onClose={() => {}} user={seed} serverId={SERVER} serverName="Kale" profile={response()} />
      </I18nProvider>
    );
    expect(screen.getByText('3 Şub 2026')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hakkımda' })).toBeInTheDocument();
    expect(screen.getByText('2 ortak topluluk')).toBeInTheDocument();
  });

  it('"No bio yet." when there is none', () => {
    render(<Harness user={{ ...seed, bio: null }} profile={response({ bio: null })} />);
    expect(within(card()).getByTestId('profile-about-body')).toHaveTextContent('No bio yet.');
  });
});

describe('status', () => {
  it('shows the status the member chose — Do Not Disturb included — and "In voice" apart from it', () => {
    render(<Harness user={{ ...seed, presence: 'dnd', inVoice: true }} />);
    expect(within(card()).getAllByText('Do Not Disturb').length).toBeGreaterThan(0);
    expect(within(card()).getByRole('img', { name: 'Do Not Disturb' })).toHaveClass('bg-danger');
    expect(within(card()).getByText('In voice')).toBeInTheDocument();
  });

  it('idle reads Idle; someone else offline reads Offline, your own reads Invisible', () => {
    const { unmount } = render(<Harness user={{ ...seed, presence: 'idle' }} />);
    expect(within(card()).getByRole('img', { name: 'Idle' })).toBeInTheDocument();
    unmount();
    const other = render(<Harness user={{ ...seed, presence: 'offline' }} />);
    expect(within(card()).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
    other.unmount();
    render(<Harness user={{ ...seed, presence: 'offline' }} self={{ status: 'offline', onStatusChange: () => {} }} />);
    expect(within(card()).getByRole('img', { name: 'Invisible' })).toBeInTheDocument();
  });

  it('no status at all when the API withholds it (a block)', () => {
    render(<Harness profile={response({ presence: null, limited: true, blockedByMe: true, bio: null })} isBlocked />);
    expect(within(card()).queryByRole('img', { name: 'Do Not Disturb' })).toBeNull();
    expect(within(card()).getByText("This member's profile details aren't available to you.")).toBeInTheDocument();
    expect(within(card()).queryByText('Hello from the seed')).toBeNull();
  });
});

describe('photo viewer', () => {
  it('the avatar opens the viewer; Escape closes the viewer but keeps the card, and focus goes back', async () => {
    render(<Harness profile={response()} />);
    const avatar = within(card()).getByRole('button', { name: "View Ace's profile photo" });
    avatar.focus();
    fireEvent.click(avatar);
    const viewer = screen.getByRole('dialog', { name: "Ace's profile photo" });
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', `/api/users/${ALICE}/avatar?v=0123456789ab`);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: "Ace's profile photo" })).toBeNull();
    expect(card()).toBeInTheDocument();
    expect(document.activeElement).toBe(avatar);
  });

  it('the banner opens the banner', () => {
    render(<Harness profile={response()} />);
    fireEvent.click(within(card()).getByRole('button', { name: "View Ace's banner" }));
    expect(within(screen.getByRole('dialog', { name: "Ace's profile banner" })).getByRole('img')).toHaveAttribute(
      'src',
      `/api/users/${ALICE}/banner?v=abcdefabcdef`
    );
  });

  it('without a banner, a coloured band (the role colour until the avatar is sampled)', () => {
    render(<Harness user={{ ...seed, avatarUrl: null }} profile={response({ bannerUrl: null, avatarUrl: null })} />);
    const band = card().querySelector('[data-banner-band]') as HTMLElement;
    expect(band.style.backgroundColor).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: /banner/ })).toBeNull();
  });
});

describe('Message @name', () => {
  it('Enter sends the message through the callback and clears the box', async () => {
    const onSendMessage = vi.fn(async () => null);
    render(<Harness profile={response()} onSendMessage={onSendMessage} />);
    const box = within(card()).getByRole('textbox', { name: 'Message @Ace' });
    fireEvent.change(box, { target: { value: '  hello there  ' } });
    await act(async () => {
      fireEvent.submit(box.closest('form')!);
    });
    expect(onSendMessage).toHaveBeenCalledWith(ALICE, 'hello there');
    expect(box).toHaveValue('');
  });

  it('a refusal stays inline and keeps the draft', async () => {
    const onSendMessage = vi.fn(async () => "You can't message this member.");
    render(<Harness profile={response()} onSendMessage={onSendMessage} />);
    const box = within(card()).getByRole('textbox', { name: 'Message @Ace' });
    fireEvent.change(box, { target: { value: 'hi' } });
    await act(async () => {
      fireEvent.submit(box.closest('form')!);
    });
    expect(within(card()).getByRole('alert')).toHaveTextContent("You can't message this member.");
    expect(box).toHaveValue('hi');
  });

  it('hidden for yourself, for someone you blocked, and when the API says no', () => {
    const onSendMessage = vi.fn(async () => null);
    const self = render(<Harness profile={response({}, { isSelf: true, message: false })} onSendMessage={onSendMessage} self={{ status: 'online', onStatusChange: () => {} }} />);
    expect(within(card()).queryByRole('textbox')).toBeNull();
    self.unmount();
    const blocked = render(<Harness profile={response()} onSendMessage={onSendMessage} isBlocked />);
    expect(within(card()).queryByRole('textbox')).toBeNull();
    blocked.unmount();
    render(<Harness profile={response({}, { message: false })} onSendMessage={onSendMessage} />);
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });
});

describe('the ⋯ menu', () => {
  function openMenu() {
    fireEvent.click(within(card()).getByRole('button', { name: 'More actions for Ace' }));
    return screen.getByRole('menu', { name: 'More actions for Ace' });
  }

  it('a plain member: copy the ID and block — no moderation', async () => {
    const onToggleBlock = vi.fn();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<Harness profile={response()} onToggleBlock={onToggleBlock} />);
    const menu = openMenu();
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['content_copyCopy user ID', 'blockBlock user']);
    // The first item has focus; arrows move.
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[1]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Copy user ID/ }));
    await waitFor(() => expect(within(card()).getByRole('status')).toHaveTextContent('User ID copied.'));
    expect(writeText).toHaveBeenCalledWith(ALICE);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Block user/ }));
    expect(onToggleBlock).toHaveBeenCalledWith(ALICE);
  });

  it('Escape closes the menu only', () => {
    render(<Harness profile={response()} />);
    openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(card()).toBeInTheDocument();
    expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'More actions for Ace' }));
  });

  it('a moderator: Timeout opens a confirmation and calls the timeout route with the chosen length', async () => {
    const onProfileChanged = vi.fn();
    fetchMock.mockImplementation(async () => Response.json({ timedOutUntil: new Date().toISOString() }));
    render(<Harness profile={response({}, MODERATOR_CAN)} onProfileChanged={onProfileChanged} />);
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.replace(/^[a-z_]+/, ''))).toEqual([
      'Copy user ID',
      'Timeout',
      'Kick',
      'Ban',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Timeout/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Time out Ace' });
    fireEvent.click(within(dialog).getByRole('radio', { name: '1 hour' }));
    const before = Date.now();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Time out' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/servers/${SERVER}/members/${ALICE}/timeout`);
    expect(init.method).toBe('PUT');
    const until = Date.parse(JSON.parse(String(init.body)).until);
    expect(until - before).toBeGreaterThanOrEqual(60 * 60_000 - 1000);
    expect(until - before).toBeLessThanOrEqual(60 * 60_000 + 5000);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(card()).getByRole('status')).toHaveTextContent('Ace is timed out.');
    expect(onProfileChanged).toHaveBeenCalled();
  });

  it('a refusal is said inside the dialog in the viewer’s words, from the route’s code', async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: 'nope', code: 'insufficient_rank' }, { status: 403 }));
    render(<Harness profile={response({}, MODERATOR_CAN)} />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Kick/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Kick Ace?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Kick' }));
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Their highest role is the same as yours or higher.');
    expect(fetchMock).toHaveBeenCalledWith(`/api/servers/${SERVER}/members/${ALICE}`, { method: 'DELETE', credentials: 'same-origin' });
  });

  it('Ban sends the optional reason; a kick or ban reports the removal', async () => {
    const onMemberRemoved = vi.fn();
    fetchMock.mockImplementation(async () => Response.json({ ban: {} }, { status: 201 }));
    render(<Harness profile={response({}, MODERATOR_CAN)} onMemberRemoved={onMemberRemoved} />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Ban/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Ban Ace?' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'spam' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/servers/${SERVER}/bans`);
    expect(JSON.parse(String(init.body))).toEqual({ userId: ALICE, reason: 'spam' });
    expect(onMemberRemoved).toHaveBeenCalledWith(ALICE, 'Ace was banned.');
  });

  it('an active timeout shows its end and offers Remove timeout instead', () => {
    render(<Harness profile={response({ timedOutUntil: '2030-01-01T10:00:00.000Z' }, MODERATOR_CAN)} />);
    expect(within(card()).getByText(/Timed out until/)).toBeInTheDocument();
    const menu = openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Remove timeout/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^timerTimeout$/ })).toBeNull();
  });

  it('server mute while the member is in the viewer’s voice room', async () => {
    fetchMock.mockImplementation(async () => Response.json({ success: true }));
    render(<Harness profile={response({}, { ...MODERATOR_CAN, serverMute: true })} serverMute={{ channelId: 'ch-1', muted: false }} />);
    const item = within(openMenu()).getByRole('menuitem', { name: /Server mute/ });
    await act(async () => {
      fireEvent.click(item);
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/servers/${SERVER}/channels/ch-1/members/${ALICE}/voice/mute`);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ muted: true });
  });

  it('your own card: Edit profile instead of moderation', () => {
    render(<Harness profile={response({}, { isSelf: true, message: false })} self={{ status: 'online', onStatusChange: () => {} }} />);
    const menu = openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Edit profile/ })).toHaveAttribute('href', `/settings/profile?server=${SERVER}`);
    expect(within(menu).queryByRole('menuitem', { name: /Block/ })).toBeNull();
  });
});

describe('roles', () => {
  /** The role routes: the profile GET (read fresh before each change) and the role PUT. */
  function roleRoutes(heldRoleIds: string[], put: () => Response = () => Response.json({ membership: {} })) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/profile')) return Response.json(response({}, { ...MODERATOR_CAN, currentRoleIds: heldRoleIds }));
      if (url.endsWith('/role') && init?.method === 'PUT') return put();
      return Response.json({});
    });
  }
  const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

  it('a role manager adds a role with "+" and removes one with "×", through the role route', async () => {
    const onProfileChanged = vi.fn();
    roleRoutes(['r-vet', 'r-everyone']);
    render(<Harness profile={response({}, MODERATOR_CAN)} onProfileChanged={onProfileChanged} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Add role' }));
    const list = screen.getByRole('listbox', { name: 'Add role' });
    await act(async () => {
      fireEvent.keyDown(list, { key: 'Enter' });
    });
    // The set is read fresh first, then the whole new set is PUT.
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/servers/${SERVER}/members/${ALICE}/profile`);
    let [url, init] = puts()[0] as [string, RequestInit];
    expect(url).toBe(`/api/servers/${SERVER}/members/${ALICE}/role`);
    expect(JSON.parse(String(init.body))).toEqual({ roleIds: ['r-vet', 'r-everyone', 'r-helper'] });
    expect(onProfileChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Remove role Veteran' }));
    });
    [url, init] = puts()[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ roleIds: ['r-everyone'] });
  });

  it('a role someone else gave meanwhile is kept: the change applies to the set as it is now', async () => {
    // The card was opened before another moderator added "r-trusted".
    roleRoutes(['r-vet', 'r-everyone', 'r-trusted']);
    render(<Harness profile={response({}, MODERATOR_CAN)} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Add role' }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('listbox', { name: 'Add role' }), { key: 'Enter' });
    });
    expect(JSON.parse(String((puts()[0]![1] as RequestInit).body))).toEqual({ roleIds: ['r-vet', 'r-everyone', 'r-trusted', 'r-helper'] });
  });

  it('a refusal shows under the roles', async () => {
    roleRoutes(['r-vet', 'r-everyone'], () => Response.json({ error: 'x', permissions: ['ban_members'] }, { status: 403 }));
    render(<Harness profile={response({}, MODERATOR_CAN)} />);
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Remove role Veteran' }));
    });
    expect(within(card()).getByRole('alert')).toHaveTextContent("That role has permissions you can't give out.");
  });

  it('no role controls without Manage Roles', () => {
    render(<Harness profile={response()} />);
    expect(within(card()).queryByRole('button', { name: 'Add role' })).toBeNull();
    expect(within(card()).queryByRole('button', { name: /Remove role/ })).toBeNull();
    expect(within(card()).getByText('Veteran')).toBeInTheDocument();
  });
});

describe('dialog contract', () => {
  it('focus moves into the card, Tab stays inside, Escape closes and focus returns to the opener', () => {
    render(<Harness start={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    fireEvent.click(opener);
    // Re-render with the opener as the return target, as the provider does.
    expect(card().contains(document.activeElement)).toBe(true);
    const focusables = card().querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])');
    const last = focusables[focusables.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes the card even when focus is outside it — but not while another menu has it', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('View full profile and the mutual strip ask for the full profile', () => {
    const onViewFullProfile = vi.fn();
    render(<Harness profile={response()} onViewFullProfile={onViewFullProfile} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'View full profile' }));
    expect(onViewFullProfile).toHaveBeenLastCalledWith('about');
    fireEvent.click(within(card()).getByRole('button', { name: /2 mutual communities/ }));
    expect(onViewFullProfile).toHaveBeenLastCalledWith('mutual');
  });

  it('your own card picks a status', () => {
    const onStatusChange = vi.fn();
    render(<Harness profile={response({}, { isSelf: true, message: false })} self={{ status: 'online', onStatusChange }} />);
    fireEvent.click(within(card()).getByRole('radio', { name: 'Idle' }));
    expect(onStatusChange).toHaveBeenCalledWith('idle');
    expect(within(card()).getByRole('link', { name: /Edit profile/ })).toHaveAttribute('href', `/settings/profile?server=${SERVER}`);
  });
});

describe('placeProfileCard', () => {
  const viewport = { width: 1400, height: 900 };
  it('left of an anchor on the right, right of one on the left, kept on screen', () => {
    expect(placeProfileCard({ left: 1200, right: 1380, top: 300 }, { width: 360, height: 500 }, viewport)).toEqual({ left: 828, top: 276 });
    expect(placeProfileCard({ left: 20, right: 220, top: 800 }, { width: 360, height: 500 }, viewport)).toEqual({ left: 232, top: 388 });
  });

  it('centred on a phone', () => {
    expect(placeProfileCard({ left: 10, right: 50, top: 100 }, { width: 360, height: 400 }, { width: 390, height: 844 })).toEqual({ left: 15, top: 76 });
  });
});
