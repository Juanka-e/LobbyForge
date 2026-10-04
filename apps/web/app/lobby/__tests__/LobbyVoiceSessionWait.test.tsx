// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LobbyVoiceProvider, useLobbyVoice } from '../LobbyVoiceProvider';

/**
 * Final-test finding (UX): clicking a voice channel right after the lobby
 * loaded showed "Session not ready - try again in a moment." — the click
 * landed while the provider was still looking up the session. A click
 * made during the lookup now waits for it and then joins.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/components/captcha/GuestVerificationDialog', () => ({
  GuestVerificationDialog: ({ open, onDismiss }: { open: boolean; onDismiss: () => void }) =>
    open ? (
      <div>
        <p>bot check</p>
        <button type="button" onClick={onDismiss}>
          close bot check
        </button>
      </div>
    ) : null,
}));

const NOT_READY = 'Session not ready - try again in a moment.';
const GUEST = { gid: 'g_1', uid: '00000000-0000-4000-8000-000000000001', name: 'Ada' };

let releaseLookup: (res: Response) => void = () => {};
let guestPost: () => Response = () => Response.json({ guest: GUEST }, { status: 201 });
let tokenRequests = 0;

beforeEach(() => {
  tokenRequests = 0;
  guestPost = () => Response.json({ guest: GUEST }, { status: 201 });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/guest' && (init.method ?? 'GET') === 'GET') {
        // The session lookup stays in flight until the test releases it.
        return new Promise<Response>((resolve) => {
          releaseLookup = resolve;
        });
      }
      if (url === '/api/auth/guest') return Promise.resolve(guestPost());
      if (url === '/api/livekit/token') {
        tokenRequests += 1;
        // Stop the join here: the test only needs to see it get this far.
        return Promise.resolve(Response.json({ error: 'token stub' }, { status: 503 }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe() {
  const voice = useLobbyVoice();
  return (
    <div>
      <button type="button" onClick={() => void voice.connectToChannel('voice-1')}>
        join
      </button>
      <button type="button" onClick={() => void voice.disconnect()}>
        leave
      </button>
      <p data-testid="state">
        {voice.connecting ? 'connecting' : 'idle'}:{voice.activeChannelId ?? 'none'}
      </p>
      <p data-testid="error">{voice.error ?? ''}</p>
    </div>
  );
}

function renderLobby() {
  render(
    <I18nProvider {...providerPropsFor('en')}>
      <LobbyVoiceProvider serverId="srv-1" livekitUrl="ws://localhost:7880" knownNames={{}} localDisplayName="Ada">
        <Probe />
      </LobbyVoiceProvider>
    </I18nProvider>
  );
}

const state = () => screen.getByTestId('state').textContent;
const error = () => screen.getByTestId('error').textContent;

describe('joining voice while the session lookup is in flight', () => {
  it('waits for the lookup, then joins — never "Session not ready"', async () => {
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'join' }));

    // The click registers at once as a channel being joined.
    await waitFor(() => expect(state()).toBe('connecting:voice-1'));
    expect(error()).toBe('');
    expect(tokenRequests).toBe(0);

    await act(async () => {
      releaseLookup(Response.json({ guest: GUEST }));
    });

    await waitFor(() => expect(tokenRequests).toBe(1));
    await waitFor(() => expect(error()).toBe('token stub'));
    expect(error()).not.toBe(NOT_READY);
  });

  it('keeps the lookup failure as the message when it fails', async () => {
    guestPost = () => Response.json({ error: 'boom' }, { status: 500 });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    await waitFor(() => expect(state()).toBe('connecting:voice-1'));

    await act(async () => {
      releaseLookup(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    });

    await waitFor(() => expect(error()).toBe('Could not start your session (500).'));
    expect(state()).toBe('idle:none');
    expect(tokenRequests).toBe(0);
  });

  it('after a failed lookup, the next click looks again and joins — "try again" works without a reload', async () => {
    guestPost = () => Response.json({ error: 'boom' }, { status: 500 });
    renderLobby();
    await act(async () => {
      releaseLookup(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    });
    await waitFor(() => expect(error()).toBe('Could not start your session (500).'));

    // The server recovers; the person clicks again.
    guestPost = () => Response.json({ guest: GUEST }, { status: 201 });
    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    await waitFor(() => expect(state()).toBe('connecting:voice-1'));
    expect(error()).toBe('');
    await act(async () => {
      releaseLookup(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    });
    await waitFor(() => expect(tokenRequests).toBe(1));
    expect(error()).not.toBe(NOT_READY);
  });

  it('a disconnect while waiting cancels the join', async () => {
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    await waitFor(() => expect(state()).toBe('connecting:voice-1'));

    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    await waitFor(() => expect(state()).toBe('idle:none'));

    await act(async () => {
      releaseLookup(Response.json({ guest: GUEST }));
    });
    // Give a stray join every chance to show up.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(tokenRequests).toBe(0);
    expect(state()).toBe('idle:none');
    expect(error()).toBe('');
  });

  it('a click while the lookup turns into a bot check leaves the check to ask — no error', async () => {
    guestPost = () => Response.json({ error: 'captcha_required' }, { status: 400 });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    await waitFor(() => expect(state()).toBe('connecting:voice-1'));

    await act(async () => {
      releaseLookup(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    });

    expect(await screen.findByText('bot check')).toBeTruthy();
    await waitFor(() => expect(state()).toBe('idle:none'));
    expect(error()).toBe('');
    expect(tokenRequests).toBe(0);
  });

  it('joining after the bot check was closed opens it again', async () => {
    guestPost = () => Response.json({ error: 'captcha_required' }, { status: 400 });
    renderLobby();
    await act(async () => {
      releaseLookup(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'close bot check' }));
    await waitFor(() => expect(screen.queryByText('bot check')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    expect(await screen.findByText('bot check')).toBeTruthy();
    expect(error()).not.toBe(NOT_READY);
  });

  it('joins straight away once the session is known', async () => {
    renderLobby();
    await act(async () => {
      releaseLookup(Response.json({ guest: GUEST }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'join' }));
    await waitFor(() => expect(tokenRequests).toBe(1));
    expect(error()).not.toBe(NOT_READY);
  });
});
