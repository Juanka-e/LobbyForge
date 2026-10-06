// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { EmailStatusSeed, __resetEmailStatusStoreForTests } from '@/components/email-verification/email-status-store';
import type { EmailStatus } from '@/components/email-verification/email-status';
import { LobbyComposer } from '../LobbyComposer';

/**
 * EMAIL.md §4.2 in the lobby: a restricted account reads but does not post.
 * The composer locks up front from the status, and a stale status that
 * still earns a 403 `email_unverified` locks it then — keeping the draft —
 * instead of printing the route's error.
 */

configure({ asyncUtilTimeout: 5_000 });

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const MESSAGES_URL = `/api/servers/${SERVER}/channels/${CHANNEL}/messages`;

function status(overrides: Partial<EmailStatus> = {}): EmailStatus {
  return {
    email: 'ada@example.org',
    verified: false,
    mode: 'required',
    restricted: false,
    pendingChange: null,
    resendAvailableAt: null,
    mailConfigured: true,
    ...overrides,
  };
}

let current = status();
let messageAnswer: () => Response = () => Response.json({ message: { id: 'm1', content: 'hi', userId: 'u1', createdAt: new Date().toISOString() } }, { status: 201 });
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/auth/email/status') return Response.json(current);
  if (url === MESSAGES_URL) return messageAnswer();
  return Response.json({});
});

function renderComposer(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyComposer channelName="general" serverId={SERVER} channelId={CHANNEL} live members={[]} />
    </I18nProvider>
  );
}

beforeEach(() => {
  __resetEmailStatusStoreForTests();
  current = status();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LobbyComposer — email restriction', () => {
  it('locks up front for a restricted account, with a way to verify', async () => {
    current = status({ restricted: true });
    renderComposer();
    expect(await screen.findByText('Verify your email to send messages.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Verify email' })).toBeInTheDocument();
  });

  it('a status the page read on the server locks it in the first render, without asking again', () => {
    render(
      <I18nProvider {...providerPropsFor('en')}>
        <EmailStatusSeed status={status({ restricted: true })}>
          <LobbyComposer channelName="general" serverId={SERVER} channelId={CHANNEL} live members={[]} />
        </EmailStatusSeed>
      </I18nProvider>
    );
    // Synchronously: no flip after a fetch.
    expect(screen.getByText('Verify your email to send messages.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/email/status')).toBe(false);
  });

  it('posts normally for an account that is not restricted', async () => {
    renderComposer();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/email/status', expect.anything()));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === MESSAGES_URL)).toBe(true));
  });

  it('a 403 email_unverified locks the composer instead of showing the raw error', async () => {
    messageAnswer = () => Response.json({ error: 'email_unverified' }, { status: 403 });
    renderComposer();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/email/status', expect.anything()));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'hello' } });
    // The server now says restricted too.
    current = status({ restricted: true });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('Verify your email to send messages.')).toBeInTheDocument();
    expect(screen.queryByText('email_unverified')).toBeNull();
  });

  it('speaks Turkish', async () => {
    current = status({ restricted: true });
    renderComposer('tr');
    expect(await screen.findByText('Mesaj göndermek için e-postanı doğrula.')).toBeInTheDocument();
  });
});
