// @vitest-environment happy-dom
/**
 * The members page opens to moderators, not only the owner — so each
 * control is drawn only for a viewer the route behind it will accept:
 * Save roles (Manage Roles), Kick (Kick Members; leaving is always
 * allowed), Ban (Ban Members), the join-request queue (Kick Members or
 * Manage Community) and Mark verified (instance admin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MembersClient, { type MemberCapabilities, type MemberView } from '../MembersClient';

const OWNER = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-000000000002';
const ADA = '00000000-0000-4000-8000-000000000003';

const NONE: MemberCapabilities = { setRoles: false, kick: false, ban: false, reviewJoinRequests: false, verifyEmail: false };

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

const fetchMock = vi.fn(
  async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify({ requests: [], pendingCount: 0, nextOffset: null }), { status: 200 })
);

function renderAs(capabilities: Partial<MemberCapabilities>, serverId: string | null = null) {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <MembersClient
        serverId={serverId}
        currentUserId={ME}
        ownerUserId={OWNER}
        members={[
          member(OWNER, 'Olivia'),
          member(ME, 'Me'),
          member(ADA, 'Ada', { emailState: 'unverified' }),
        ]}
        roles={[{ id: 'r1', name: 'Moderator', color: null, position: 1, permissions: ['kick_members'] }]}
        loadError={null}
        capabilities={{ ...NONE, ...capabilities }}
      />
    </I18nProvider>
  );
}

const manage = (name: string) => screen.queryByRole('button', { name: `Manage ${name}` });

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('member actions by permission', () => {
  it('a moderator with Kick Members can kick, and is offered nothing else', () => {
    renderAs({ kick: true, reviewJoinRequests: true });
    fireEvent.click(manage('Ada')!);
    expect(screen.getByRole('button', { name: 'Kick' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Moderator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark email as verified' })).toBeNull();
  });

  it('never offers anything on the owner’s row to a moderator', () => {
    renderAs({ kick: true, ban: true });
    expect(manage('Olivia')).toBeNull();
  });

  it('a role manager gets the role picker but no kick or ban', () => {
    renderAs({ setRoles: true });
    fireEvent.click(manage('Ada')!);
    expect(screen.getByRole('button', { name: 'Moderator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save roles' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
  });

  it('a Manage Community holder sees no member actions — only Leave on their own row', () => {
    renderAs({ reviewJoinRequests: true });
    expect(manage('Ada')).toBeNull();
    fireEvent.click(manage('Me')!);
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  it('shows Mark email as verified only to the instance admin', () => {
    renderAs({ setRoles: true, kick: true, ban: true, verifyEmail: true });
    fireEvent.click(manage('Ada')!);
    expect(screen.getByRole('button', { name: 'Mark email as verified' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
  });

  it('loads the join-request queue only for those who may review it', () => {
    renderAs({ ban: true }, 'srv-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/join-requests'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Join requests' })).toBeNull();
  });
});
