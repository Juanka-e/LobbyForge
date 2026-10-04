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

/**
 * Final-test finding (UX): a refused redeem showed developer text such as
 * "redeem → 500 Failed to redeem invite". Each refusal is now a
 * translated message, with no status code or server text in the page.
 */
describe('/join/[code] when the redeem is refused', () => {
  type InviteState = { isExpired: boolean; isExhausted: boolean } | 'gone';
  let inviteReads = 0;

  /** The first invite read is the page load; later reads follow a refusal. */
  function stubRefusal(answer: () => Response | Promise<Response>, afterRefusal: InviteState = { isExpired: false, isExhausted: false }) {
    inviteReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: undefined });
        if (url === `/api/invites/${CODE}`) {
          inviteReads += 1;
          if (inviteReads === 1) return Response.json(invite(false));
          if (afterRefusal === 'gone') return Response.json({ error: 'Invite not found' }, { status: 404 });
          return Response.json({ invite: { ...invite(false).invite, ...afterRefusal } });
        }
        if (url === '/api/auth/guest') return Response.json({ guest: { gid: 'g_1', uid: 'user-1', name: 'Ada' } });
        if (url === `/api/servers/${SERVER}/join-requests/mine`) return Response.json({ request: null });
        if (url === `/api/invites/${CODE}/redeem`) return answer();
        return Response.json({}, { status: 404 });
      })
    );
  }

  async function accept(locale = 'en') {
    renderPage(locale);
    const button = await screen.findByRole('button', { name: locale === 'tr' ? 'Daveti kabul et' : 'Accept invite' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    return button as HTMLButtonElement;
  }

  /** Nothing developer-facing reached the page. */
  function expectNoDetails() {
    expect(screen.queryByText(/redeem|→|\b(4\d\d|5\d\d)\b|Failed to|Invite is unavailable|banned from this server/)).toBeNull();
  }

  it('a server error is a friendly retry message', async () => {
    stubRefusal(() => Response.json({ error: 'Failed to redeem invite' }, { status: 500 }));
    await accept();
    expect(await screen.findByText("Something went wrong and the invite wasn't accepted. Try again in a moment.")).toBeTruthy();
    expectNoDetails();
  });

  it('an invite that expired since the page loaded says so, and the button turns off', async () => {
    stubRefusal(() => Response.json({ error: 'Invite is unavailable' }, { status: 403 }), { isExpired: true, isExhausted: false });
    const button = await accept();
    expect(await screen.findByText('This invite has expired. Ask whoever sent it for a new one.')).toBeTruthy();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    expectNoDetails();
  });

  it('an invite used up since the page loaded says so', async () => {
    stubRefusal(() => Response.json({ error: 'Invite is unavailable' }, { status: 403 }), { isExpired: false, isExhausted: true });
    await accept();
    expect(await screen.findByText('This invite has been used as many times as it allows. Ask for a new one.')).toBeTruthy();
  });

  it('an invite revoked since the page loaded says so', async () => {
    stubRefusal(() => Response.json({ error: 'Invite is unavailable' }, { status: 403 }), 'gone');
    await accept();
    expect(await screen.findByText('This invite was revoked.')).toBeTruthy();
  });

  it("the route's ban refusal is a ban message, without the server text", async () => {
    stubRefusal(() => Response.json({ error: 'You are banned from this server' }, { status: 403 }));
    await accept();
    expect(await screen.findByText("You can't join this server because you've been banned from it.")).toBeTruthy();
    expect(inviteReads).toBe(1);
    expectNoDetails();
  });

  it('a 403 from the origin guard is not mistaken for a ban', async () => {
    stubRefusal(() => Response.json({ error: 'Invalid request origin' }, { status: 403 }));
    await accept();
    expect(await screen.findByText("Something went wrong and the invite wasn't accepted. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText(/banned/)).toBeNull();
    expectNoDetails();
  });

  it('a ban the route names with a code needs no second look at the invite', async () => {
    stubRefusal(() => Response.json({ error: 'You are banned from this server', code: 'banned' }, { status: 403 }));
    await accept();
    expect(await screen.findByText("You can't join this server because you've been banned from it.")).toBeTruthy();
    expect(inviteReads).toBe(1);
  });

  it('the rate limiter is a wait-and-retry message', async () => {
    stubRefusal(() => Response.json({ error: 'Rate limit exceeded', retryAfter: 30 }, { status: 429 }));
    await accept();
    expect(await screen.findByText('Too many attempts. Wait a minute, then try again.')).toBeTruthy();
    expectNoDetails();
  });

  it('a network failure is the friendly retry message too', async () => {
    stubRefusal(() => Promise.reject(new TypeError('Failed to fetch')));
    await accept();
    expect(await screen.findByText("Something went wrong and the invite wasn't accepted. Try again in a moment.")).toBeTruthy();
    expectNoDetails();
  });

  it('is translated', async () => {
    stubRefusal(() => Response.json({ error: 'Failed to redeem invite' }, { status: 500 }));
    await accept('tr');
    expect(await screen.findByText('Bir şeyler ters gitti, davet kabul edilmedi. Birazdan yeniden dene.')).toBeTruthy();
  });

  it('a failed invite load shows no response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/invites/${CODE}`) return Response.json({ error: 'boom', stack: 'at x' }, { status: 500 });
        return Response.json({}, { status: 401 });
      })
    );
    renderPage();
    expect(await screen.findByText("This invite couldn't be loaded. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText(/boom|stack|\{/)).toBeNull();
  });
});
