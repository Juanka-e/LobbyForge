// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyJoinRequestActions } from '../LobbyJoinRequestActions';

/**
 * The lobby's "Ask to join" / "Withdraw request" buttons: the page load
 * files nothing, these explicit POST / DELETE calls do, and the
 * server-rendered page is refreshed to show the new state.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const MINE = `/api/servers/${SERVER}/join-requests/mine`;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  refresh.mockReset();
  respond = () => Response.json({ status: 'pending_approval', request: { id: 'jr-1' } }, { status: 202 });
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

function renderActions(mode: 'ask' | 'pending', locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyJoinRequestActions serverId={SERVER} mode={mode} />
    </I18nProvider>
  );
}

describe('LobbyJoinRequestActions — ask', () => {
  it('sends nothing until the button is pressed, then POSTs the trimmed note and refreshes the page', async () => {
    renderActions('ask');
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Message to the moderators (optional)'), {
      target: { value: '  I host the Friday quiz ' },
    });
    const button = screen.getByRole('button', { name: 'Ask to join' });
    fireEvent.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ url: MINE, method: 'POST', body: { note: 'I host the Friday quiz' } }]);
    // Stays busy until the refreshed page replaces it (no double submit).
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks without a body when the note is empty', async () => {
    renderActions('ask');
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toEqual({ url: MINE, method: 'POST', body: undefined });
  });

  it('caps the note at the API limit', () => {
    renderActions('ask');
    expect((screen.getByLabelText('Message to the moderators (optional)') as HTMLTextAreaElement).maxLength).toBe(500);
  });

  it('the daily limit is explained in place, and the button comes back', async () => {
    respond = () => Response.json({ code: 'join_request_limit' }, { status: 429 });
    renderActions('ask');
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You’ve asked to join this community too many times today. Try again tomorrow.'
    );
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Ask to join' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('declined, banned, already in, or no approval needed: the page is refreshed to say which', async () => {
    for (const code of ['join_rejected', 'banned', 'already_member', 'approval_not_required']) {
      refresh.mockReset();
      respond = () => Response.json({ code }, { status: code.startsWith('a') ? 409 : 403 });
      const view = renderActions('ask');
      fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('alert')).toBeNull();
      view.unmount();
    }
  });

  it('any other failure shows a generic message, never a status code', async () => {
    respond = () => Response.json({ error: 'Failed to send the join request' }, { status: 500 });
    renderActions('ask');
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Your request could not be sent. Try again in a moment.');
    expect(alert.textContent).not.toMatch(/500/);
    expect(screen.getByRole('button', { name: 'Ask to join' }).getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('is translated', () => {
    renderActions('ask', 'tr');
    expect(screen.getByLabelText('Moderatörlere mesaj (isteğe bağlı)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Katılmak için istek gönder' })).toBeTruthy();
  });
});

describe('LobbyJoinRequestActions — pending', () => {
  it('withdraws the request with a DELETE and refreshes the page', async () => {
    respond = () => Response.json({ cancelled: true });
    renderActions('pending');
    expect(screen.queryByRole('button', { name: 'Ask to join' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ url: MINE, method: 'DELETE', body: undefined }]);
  });

  it('a failed withdraw says so and keeps the button', async () => {
    respond = () => new Response(null, { status: 503 });
    renderActions('pending');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your request could not be withdrawn. Try again in a moment.'
    );
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Withdraw request' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is translated', () => {
    renderActions('pending', 'tr');
    expect(screen.getByRole('button', { name: 'İsteği geri çek' })).toBeTruthy();
  });
});
