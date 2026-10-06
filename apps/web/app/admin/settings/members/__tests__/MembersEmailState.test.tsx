// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MembersClient, { type MemberView } from '../MembersClient';

const fetchMock = vi.fn();

function member(overrides: Partial<MemberView>): MemberView {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    displayName: 'Ada',
    globalDisplayName: 'Ada',
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

function renderMembers(members: MemberView[], locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <MembersClient serverId={null} currentUserId="owner" ownerUserId="owner" members={members} roles={[]} loadError={null} />
    </I18nProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Members list — email verification (EMAIL.md §5)', () => {
  it('shows each member\'s verification state in words', () => {
    renderMembers([
      member({ userId: 'u1', displayName: 'Ada', emailState: 'verified' }),
      member({ userId: 'u2', displayName: 'Bea', emailState: 'unverified' }),
      member({ userId: 'u3', displayName: 'Guest Cy', isGuest: true, emailState: 'none' }),
    ]);
    expect(screen.getByText('Email verified')).toBeInTheDocument();
    expect(screen.getByText('Email not verified')).toBeInTheDocument();
    expect(screen.getAllByText(/Email (not )?verified/)).toHaveLength(2);
  });

  it('marks an unverified member as verified through the admin route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderMembers([member({ userId: 'u2', displayName: 'Bea', emailState: 'unverified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Bea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark email as verified' }));
    expect(await screen.findByText("Bea's email is now marked as verified.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u2/verify-email', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('Email verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark email as verified' })).toBeNull();
  });

  it('says so when the account is gone', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    renderMembers([member({ userId: 'u2', displayName: 'Bea', emailState: 'unverified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Bea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark email as verified' }));
    expect(await screen.findByText('This account no longer exists.')).toBeInTheDocument();
  });
});
