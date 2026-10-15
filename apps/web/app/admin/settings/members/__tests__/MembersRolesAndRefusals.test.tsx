// @vitest-environment happy-dom
/**
 * Two findings of the A-to-Z e2e run on the Members page:
 *
 *  - the Role column showed "@EVERYONE" for a moderator: the page (and the
 *    server) took the FIRST role of the set as the display role, and the
 *    set starts with @everyone. It is now the highest role other than
 *    @everyone, after a save as on load;
 *  - a refused kick, ban or role change showed the server's English
 *    `error` to every language. It is now said from the route's `code`,
 *    and a failure with no known reason keeps the page's own sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MembersClient, { type MemberView } from '../MembersClient';

// The ban list (its own section, tested in BansSection.test.tsx) would take
// this file's queued fetch answers.
vi.mock('../BansSection', () => ({ default: () => null }));

const OWNER = '00000000-0000-4000-8000-000000000001';
const ADA = '00000000-0000-4000-8000-000000000003';

const ROLES = [
  { id: 'r-staff', name: 'Staff', color: '#22aa66', position: 5, permissions: ['kick_members'] },
  { id: 'r-mod', name: 'Moderator', color: '#3366ff', position: 1, permissions: ['kick_members'] },
  { id: 'r-everyone', name: '@everyone', color: null, position: 0, permissions: ['send_messages'] },
];

function member(userId: string, displayName: string, overrides: Partial<MemberView> = {}): MemberView {
  return {
    userId,
    displayName,
    globalDisplayName: displayName,
    nickname: null,
    avatarUrl: null,
    isGuest: false,
    roleName: null,
    roleColor: null,
    roleIds: [],
    joinedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

let respond: (url: string, init?: RequestInit) => Response;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init));

function renderPage(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <MembersClient
        serverId="srv-1"
        currentUserId={OWNER}
        ownerUserId={OWNER}
        members={[member(OWNER, 'Olivia'), member(ADA, 'Ada', { roleIds: ['r-everyone'] })]}
        roles={ROLES}
        loadError={null}
        capabilities={{ setRoles: true, kick: true, ban: true, reviewJoinRequests: false, verifyEmail: false }}
      />
    </I18nProvider>
  );
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  respond = () => json({ ok: true }, 200);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('prompt', vi.fn(() => ''));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Role column after a role change', () => {
  it('shows the highest role, not @everyone first in the set', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByText('Member roles updated.')).toBeInTheDocument();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { roleIds: string[] };
    expect(body.roleIds).toEqual(['r-everyone', 'r-mod']);
    // The row itself (the open drawer below it lists every role to pick).
    const row = screen.getByText('Ada').closest('li')!.firstElementChild!;
    expect(row).toHaveTextContent('Moderator');
    expect(row).not.toHaveTextContent('@everyone');
  });

  it('shows Member, not @everyone, when @everyone is all that is left', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    await screen.findByText('Member roles updated.');
    const row = screen.getByText('Ada').closest('li')!.firstElementChild!;
    expect(row).toHaveTextContent('Member');
    expect(row).not.toHaveTextContent('@everyone');
  });
});

describe('refusals in the viewer’s language', () => {
  async function kickAda(locale = 'en') {
    renderPage(locale);
    fireEvent.click(screen.getByRole('button', { name: locale === 'tr' ? 'Ada kullanıcısını yönet' : 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: locale === 'tr' ? 'Sunucudan at' : 'Kick' }));
  }

  it('says a kick refused before the moderation gate from its code, in Turkish', async () => {
    respond = () => json({ error: 'Cannot kick the server owner', code: 'target_is_owner' }, 400);
    await kickAda('tr');
    expect(await screen.findByText('Topluluk sahibine moderasyon uygulanamaz.')).toBeInTheDocument();
    expect(screen.queryByText(/Cannot kick/)).toBeNull();
  });

  it.each([
    ['insufficient_rank', 403, 'Their highest role is the same as yours or higher.'],
    ['actor_timed_out', 403, "You're timed out in this community."],
    ['forbidden', 403, "You don't have permission to do that."],
    ['server_not_found', 404, 'This community no longer exists.'],
    ['unauthenticated', 401, 'Your session has ended. Sign in again.'],
  ])('says kick refusal %s in words', async (code, status, sentence) => {
    respond = () => json({ error: 'English only', code }, status);
    await kickAda();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText('English only')).toBeNull();
  });

  it('says a ban refusal from its code, and keeps its own sentence for an unknown failure', async () => {
    respond = () => json({ error: 'User is already banned', code: 'already_banned' }, 409);
    const { unmount } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByText("They're already banned.")).toBeInTheDocument();
    unmount();

    respond = () => json({ error: 'Failed to create ban' }, 500);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    expect(await screen.findByText('Could not ban member')).toBeInTheDocument();
    expect(screen.queryByText('Failed to create ban')).toBeNull();
  });

  it('says a role change refused for an ungrantable permission', async () => {
    respond = () =>
      json({ error: 'You cannot grant permissions you do not have', code: 'ungrantable_permissions', permissions: ['ban_members'] }, 403);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByText("That role has permissions you can't give out.")).toBeInTheDocument();
  });

  it('says a network failure as one, not the browser’s English', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    await kickAda();
    expect(await screen.findByText("Couldn't reach the server. Check your connection.")).toBeInTheDocument();
  });
});
