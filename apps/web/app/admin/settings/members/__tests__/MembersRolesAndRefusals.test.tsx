// @vitest-environment happy-dom
/**
 * A finding of the A-to-Z e2e run on the Members page: the Role column
 * showed "@EVERYONE" for a moderator. The page (and the server) took the
 * FIRST role of the set as the display role, and the set starts with
 * @everyone. It is now the highest role other than @everyone, after a
 * save as on load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MembersClient, { type MemberView } from '../MembersClient';

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
