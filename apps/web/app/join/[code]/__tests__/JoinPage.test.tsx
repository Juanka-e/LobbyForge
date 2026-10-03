// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import JoinPage from '../page';

const CODE = 'ABCD2345EFGH';
const SERVER = '11111111-1111-4111-8111-111111111111';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let mine: { request: { status: 'pending' | 'rejected'; retryAfter: string | null } | null } = { request: null };
let redeem: () => Response = () => Response.json({}, { status: 500 });
let cancel: () => Response = () => Response.json({ cancelled: true });

function invite(requiresApproval: boolean) {
  return {
    invite: {
      code: CODE,
      serverId: SERVER,
      serverName: 'Game Night',
      expiresAt: null,
      currentUses: 1,
      maxUses: null,
      isExpired: false,
      isExhausted: false,
      requiresApproval,
    },
  };
}

function stubFetch(requiresApproval: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (url === `/api/invites/${CODE}`) return Response.json(invite(requiresApproval));
      if (url === '/api/auth/guest') return Response.json({ guest: { gid: 'g_1', uid: 'user-1', name: 'Ada' } });
      if (url === `/api/servers/${SERVER}/join-requests/mine`) {
        return call.method === 'DELETE' ? cancel() : Response.json(mine);
      }
      if (url === `/api/invites/${CODE}/redeem`) return redeem();
      return Response.json({}, { status: 404 });
    })
  );
}

beforeEach(() => {
  calls = [];
  mine = { request: null };
  cancel = () => Response.json({ cancelled: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <JoinPage params={Promise.resolve({ code: CODE })} />
    </I18nProvider>
  );
}

describe('/join/[code] under an approval policy', () => {
  it('asks to join with an optional note; 202 shows the waiting state', async () => {
    stubFetch(true);
    redeem = () => Response.json({ status: 'pending_approval', request: { id: 'jr-1' } }, { status: 202 });
    renderPage();
    expect(await screen.findByText(/This server reviews new members/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Message to the moderators (optional)'), {
      target: { value: '  friend of Grace ' },
    });
    const ask = await screen.findByRole('button', { name: 'Ask to join' });
    await vi.waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ask);
    expect(await screen.findByText(/Your request is waiting for a moderator/)).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/redeem'))!.body).toEqual({ note: 'friend of Grace' });
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeTruthy();
  });

  it('a returning visitor sees their pending request and can withdraw it', async () => {
    stubFetch(true);
    mine = { request: { status: 'pending', retryAfter: null } };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    expect(await screen.findByText('Your request was withdrawn.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/join-requests/mine'))).toBe(true);
    expect(await screen.findByRole('button', { name: 'Ask to join' })).toBeTruthy();
  });

  it('a failed withdraw says so in words, not a status code — and keeps the request', async () => {
    stubFetch(true);
    mine = { request: { status: 'pending', retryAfter: null } };
    cancel = () => Response.json({ error: 'Failed to cancel the join request' }, { status: 500 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    expect(await screen.findByText('Your request could not be withdrawn. Try again in a moment.')).toBeTruthy();
    expect(screen.queryByText(/500|cancel →/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeTruthy();
  });

  it('a declined visitor is told when they may ask again, with no button to ask now', async () => {
    stubFetch(true);
    mine = { request: { status: 'rejected', retryAfter: '2026-10-10T00:00:00.000Z' } };
    renderPage();
    expect(await screen.findByText(/A moderator declined your request to join\. You can ask again after/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask to join' })).toBeNull();
  });

  it('a plain server keeps the plain accept button and sends no body', async () => {
    stubFetch(false);
    redeem = () => Response.json({ membership: { serverId: SERVER, userId: 'user-1', roleId: 'r' } }, { status: 201 });
    renderPage();
    const accept = await screen.findByRole('button', { name: 'Accept invite' });
    await vi.waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText('Message to the moderators (optional)')).toBeNull();
    fireEvent.click(accept);
    expect(await screen.findByText('You are now a member of Game Night.')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/redeem'))!.body).toBeUndefined();
  });

  it('is translated', async () => {
    stubFetch(true);
    mine = { request: { status: 'pending', retryAfter: null } };
    renderPage('tr');
    expect(await screen.findByText(/İsteğin bir moderatörü bekliyor/)).toBeTruthy();
  });

  it('a failed withdraw is translated too', async () => {
    stubFetch(true);
    mine = { request: { status: 'pending', retryAfter: null } };
    cancel = () => new Response(null, { status: 503 });
    renderPage('tr');
    fireEvent.click(await screen.findByRole('button', { name: 'İsteği geri çek' }));
    expect(await screen.findByText('İsteğin geri çekilemedi. Birazdan yeniden dene.')).toBeTruthy();
  });
});
