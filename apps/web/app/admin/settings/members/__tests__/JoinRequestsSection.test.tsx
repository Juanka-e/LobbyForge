// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import type { JoinRequestJson } from '@/lib/join-requests';
import JoinRequestsSection from '../JoinRequestsSection';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const SERVER = '11111111-1111-4111-8111-111111111111';

function request(overrides: Partial<JoinRequestJson> = {}): JoinRequestJson {
  return {
    id: 'req-1',
    serverId: SERVER,
    userId: 'user-1',
    displayName: 'Ada',
    isGuest: true,
    accountCreatedAt: new Date().toISOString(),
    source: 'invite',
    inviteCode: null,
    inviterName: 'Owner',
    note: 'friend of Grace',
    status: 'pending',
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  refresh.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return respond(call);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listing(requests: JoinRequestJson[], extra: Record<string, unknown> = {}) {
  return Response.json({ requests, pendingCount: requests.length, nextOffset: null, ...extra });
}

function renderSection(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <JoinRequestsSection serverId={SERVER} />
    </I18nProvider>
  );
}

describe('JoinRequestsSection', () => {
  it('lists pending requests with who invited them, their note and badges', async () => {
    respond = () => listing([request(), request({ id: 'req-2', displayName: 'Lin', source: 'auto_join', note: null, isGuest: false, accountCreatedAt: '2020-01-01T00:00:00.000Z' })]);
    renderSection();
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Join requests' })).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
    expect(screen.getByText('friend of Grace')).toBeTruthy();
    expect(screen.getByText(/with an invite from Owner/)).toBeTruthy();
    expect(screen.getByText(/from the community page/)).toBeTruthy();
    // A fresh guest account is flagged; the old account is not.
    expect(screen.getAllByText('New account')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Approve Ada' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject Lin' })).toBeTruthy();
    expect(calls[0]!.url).toBe(`/api/servers/${SERVER}/join-requests?status=pending&limit=25&offset=0`);
  });

  it('approve posts the decision, drops the row and refreshes the member list', async () => {
    respond = (call) =>
      call.method === 'POST'
        ? Response.json({ request: { id: 'req-1', status: 'approved' }, membership: { serverId: SERVER, userId: 'user-1' } })
        : listing([request()]);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Ada' }));
    expect(await screen.findByText('Ada is now a member.')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/api/servers/${SERVER}/join-requests/req-1`);
    expect(post.body).toEqual({ action: 'approve' });
    expect(screen.queryByRole('button', { name: 'Approve Ada' })).toBeNull();
    expect(screen.getByText('No one is waiting for approval.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reject asks first; cancelling the prompt sends nothing', async () => {
    respond = (call) =>
      call.method === 'POST' ? Response.json({ request: { id: 'req-1', status: 'rejected' } }) : listing([request()]);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    renderSection();
    const reject = await screen.findByRole('button', { name: 'Reject Ada' });
    fireEvent.click(reject);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(reject);
    expect(await screen.findByText('The request from Ada was rejected.')).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ action: 'reject' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says so when the user was banned meanwhile, or another moderator was faster', async () => {
    let attempt = 0;
    respond = (call) => {
      if (call.method !== 'POST') return listing([request(), request({ id: 'req-2', displayName: 'Lin' })]);
      attempt += 1;
      return attempt === 1
        ? Response.json({ code: 'banned' }, { status: 409 })
        : Response.json({ code: 'not_pending' }, { status: 409 });
    };
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Ada' }));
    expect(await screen.findByText('Ada is banned from this community, so the request was rejected.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Lin' }));
    expect(await screen.findByText('Another moderator already decided this request.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('No one is waiting for approval.')).toBeTruthy());
  });

  it('explains the permission when the API refuses the list', async () => {
    respond = () => Response.json({ error: 'Forbidden' }, { status: 403 });
    renderSection();
    expect(await screen.findByText(/needs the Kick Members or Manage Community permission/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('loads the next page on demand', async () => {
    respond = (call) =>
      call.url.endsWith('offset=0')
        ? listing([request()], { pendingCount: 2, nextOffset: 1 })
        : listing([request({ id: 'req-2', displayName: 'Lin' })], { pendingCount: 2 });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Lin')).toBeTruthy();
    expect(calls.at(-1)!.url).toContain('offset=1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('is translated', async () => {
    respond = () => listing([request()]);
    renderSection('tr');
    expect(await screen.findByRole('heading', { name: 'Katılım istekleri' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ada kişisini onayla' })).toBeTruthy();
    expect(screen.getByText('1 kişi bekliyor')).toBeTruthy();
  });
});
