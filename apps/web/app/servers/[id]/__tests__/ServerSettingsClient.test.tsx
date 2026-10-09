// @vitest-environment happy-dom
/**
 * A community's settings page draws only what its viewer may use: the
 * page lets in Manage Community holders, and hands over the rest of what
 * they may do. No "Owner only" buttons, no tab that would only be refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ServerSettingsClient, { visibleTabs, type ServerSettingsViewer } from '../ServerSettingsClient';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const SERVER = '00000000-0000-4000-8000-0000000000aa';
const OWNER = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-000000000002';
const ADA = '00000000-0000-4000-8000-000000000003';

const NOTHING_ELSE: ServerSettingsViewer['can'] = {
  manageChannels: false,
  kickMembers: false,
  createInvite: false,
  viewAuditLog: false,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url === `/api/servers/${SERVER}`) return json({ server: { id: SERVER, name: 'Night Owls', ownerUserId: OWNER } });
  if (url.endsWith('/channels')) return json({ channels: [{ id: 'c1', serverId: SERVER, name: 'general', type: 'text', position: 0, topic: null }] });
  if (url.endsWith('/members'))
    return json({
      members: [
        { userId: OWNER, displayName: 'Olivia', isOwner: true, roleId: null },
        { userId: ME, displayName: 'Me', isOwner: false, roleId: null },
        { userId: ADA, displayName: 'Ada', isOwner: false, roleId: null },
      ],
    });
  if (url.endsWith('/roles')) return json({ roles: [] });
  if (url.endsWith('/invites')) return json({ invites: [] });
  if (url.endsWith('/apps'))
    return json({
      apps: [{ id: 'poll', name: 'Poll', version: '1.0.0', type: 'game', catalog: null, installed: false, enabled: false, settings: {}, installedAt: null }],
    });
  if (url.endsWith('/access-policy'))
    return json({
      accessPolicy: {
        joinPolicy: 'invite_only',
        externalIdentity: 'off',
        localAccount: 'allow_local_email_password',
        accountLinking: 'allow_link',
        requireApprovalForFirstJoin: false,
        updatedAt: null,
      },
    });
  if (url.endsWith('/bots')) return json({ bots: [] });
  return new Response('{}', { status: 404 });
});

function renderAs(can: Partial<ServerSettingsViewer['can']>, initialTab: 'overview' | 'apps' | 'access' | 'invites' | 'audit' = 'overview') {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <ServerSettingsClient
        serverId={SERVER}
        viewer={{ userId: ME, isOwner: false, can: { ...NOTHING_ELSE, ...can } }}
        initialTab={initialTab}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tabs', () => {
  it('hides Invites without Create Invite and Audit Log without View Audit Log', () => {
    expect(visibleTabs(NOTHING_ELSE)).toEqual(['overview', 'apps', 'access', 'bots', 'roles']);
    expect(visibleTabs({ ...NOTHING_ELSE, createInvite: true, viewAuditLog: true })).toEqual([
      'overview',
      'apps',
      'access',
      'bots',
      'roles',
      'invites',
      'audit',
    ]);
  });

  it('draws only those tabs, and opens the overview instead of a hidden one', async () => {
    renderAs({}, 'audit');
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invites/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Audit Log/ })).toBeNull();
    // The invites route would refuse this viewer, so it is not asked.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/invites'))).toBe(false);
  });
});

describe('controls', () => {
  it('offers no Add channel or Kick to a manager without those permissions', async () => {
    renderAs({});
    await screen.findByText('Ada');
    expect(screen.queryByRole('button', { name: 'Add channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(screen.queryByText(/Owner only/)).toBeNull();
  });

  it('offers Kick on others — never the owner or yourself — with Kick Members', async () => {
    renderAs({ kickMembers: true, manageChannels: true });
    await screen.findByText('Ada');
    expect(screen.getAllByRole('button', { name: 'Kick' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add channel' })).toBeInTheDocument();
  });

  it('lets a non-owner manager install apps and save the access policy', async () => {
    renderAs({}, 'apps');
    const install = await screen.findByRole('button', { name: /Install/ });
    expect(install).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^.*Access$/ }));
    expect(await screen.findByRole('button', { name: 'Save access policy' })).toBeEnabled();
  });
});
