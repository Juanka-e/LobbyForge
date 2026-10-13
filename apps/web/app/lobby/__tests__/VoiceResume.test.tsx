// @vitest-environment happy-dom
/**
 * Coming back to voice after a reload (docs/ACTIVITY_INTEGRITY_AND_
 * RESILIENCE.md §3.2): a page reload used to drop the person out of voice
 * with nothing to bring them back, and always reopened the chat.
 *
 *  - a fresh record offers "Back to #channel"; the click joins through the
 *    provider's usual join;
 *  - after a reload with the microphone already allowed it goes back by
 *    itself; otherwise it waits for the click;
 *  - a stale record, a channel that is gone, another tab in voice, a
 *    dismissal, leaving and a voice block all end the offer;
 *  - the activities view a tab was showing comes back after a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { LOBBY_VIEW_KEY, VOICE_LOCK_NAME, VOICE_RESUME_KEY } from '@/lib/voice-resume';
import { LobbyVoiceProvider, useLobbyVoice } from '../LobbyVoiceProvider';
import { VoiceResumeStrip } from '../VoiceResumeStrip';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/components/captcha/GuestVerificationDialog', () => ({
  GuestVerificationDialog: () => null,
}));

const GUEST = { gid: 'g_1', uid: '00000000-0000-4000-8000-000000000001', name: 'Ada' };
const CHANNELS = [
  { id: 'voice-1', name: 'Lounge' },
  { id: 'voice-2', name: 'Stage' },
];

let tokenBodies: Array<Record<string, unknown>> = [];
let tokenResponse: () => Response = () => Response.json({ error: 'token stub' }, { status: 503 });

function setNavigationType(type: string | null) {
  vi.spyOn(globalThis.performance, 'getEntriesByType').mockImplementation(
    (kind: string) => (kind === 'navigation' && type ? [{ type } as unknown as PerformanceEntry] : []) as PerformanceEntryList
  );
}

function setMicrophone(state: PermissionState) {
  Object.defineProperty(globalThis.navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state }) },
  });
}

function seedRecord(overrides: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(
    VOICE_RESUME_KEY,
    JSON.stringify({ serverId: 'srv-1', channelId: 'voice-1', channelName: 'Lounge', at: Date.now() - 10_000, ...overrides })
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  tokenBodies = [];
  tokenResponse = () => Response.json({ error: 'token stub' }, { status: 503 });
  setNavigationType('navigate');
  setMicrophone('prompt');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/guest') return Response.json({ guest: GUEST });
      if (url === '/api/livekit/token') {
        tokenBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return tokenResponse();
      }
      return Response.json({}, { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis.navigator as { permissions?: unknown }).permissions;
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

function Probe() {
  const voice = useLobbyVoice();
  return (
    <div>
      <p data-testid="state">
        {voice.connecting ? 'connecting' : 'idle'}:{voice.activeChannelId ?? 'none'}
      </p>
      <p data-testid="error">{voice.error ?? ''}</p>
      <p data-testid="view">
        {voice.mainViewMode}:{voice.activeActivityChannel?.channelName ?? '-'}
      </p>
      <button type="button" onClick={() => void voice.connectToChannel('voice-1')}>
        join voice-1
      </button>
      <button type="button" onClick={() => void voice.disconnect()}>
        leave
      </button>
      <button type="button" onClick={() => voice.setMainViewMode('chat')}>
        to chat
      </button>
      <button type="button" onClick={() => voice.openActivities({ channelId: 'voice-1', channelName: 'Lounge' })}>
        open activities
      </button>
    </div>
  );
}

function renderLobby(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceProvider
        serverId="srv-1"
        livekitUrl="ws://localhost:7880"
        knownNames={{}}
        localDisplayName="Ada"
        voiceChannels={CHANNELS}
      >
        <VoiceResumeStrip placement="lobby" />
        <Probe />
      </LobbyVoiceProvider>
    </I18nProvider>
  );
}

/** Let the provider's mount checks (storage, permissions, the lock) settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const stored = () => window.sessionStorage.getItem(VOICE_RESUME_KEY);

describe('the way back to voice after a reload', () => {
  it('offers "Back to #channel", and the click joins that channel', async () => {
    setNavigationType('reload');
    seedRecord();
    renderLobby();

    const strip = await screen.findByTestId('voice-resume-strip');
    expect(strip).toHaveAttribute('role', 'status');
    expect(strip).toHaveTextContent('You dropped out of voice.');
    // The microphone permission was not granted: nothing joins by itself.
    await settle();
    expect(tokenBodies).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Back to #Lounge' }));
    await waitFor(() => expect(tokenBodies).toHaveLength(1));
    expect(tokenBodies[0]).toMatchObject({ serverId: 'srv-1', channelId: 'voice-1' });

    // The join failed for a reason that may pass (503): the offer comes
    // back, with the reason in it.
    await waitFor(() => expect(screen.getByTestId('voice-resume-strip')).toHaveTextContent('token stub'));
    expect(stored()).not.toBeNull();
  });

  // At 390 px the message used to shrink to nothing next to the button
  // ("You / dropped / out / of / voice." one word per line): it keeps a
  // floor, so the strip's flex-wrap moves the button to the next line.
  it('keeps a minimum width for the sentence so the button wraps on a phone', async () => {
    seedRecord();
    renderLobby();
    const strip = await screen.findByTestId('voice-resume-strip');
    expect(strip.className).toContain('flex-wrap');
    const message = screen.getByTestId('voice-resume-message');
    expect(message.className).toMatch(/\bmin-w-\[10rem\]/);
    expect(message.className).not.toMatch(/\bmin-w-0\b/);
  });

  it('says it in Turkish', async () => {
    seedRecord();
    renderLobby('tr');
    expect(await screen.findByTestId('voice-resume-strip')).toHaveTextContent('Sesten düştün.');
    expect(screen.getByRole('button', { name: '#Lounge kanalına dön' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kapat' })).toBeInTheDocument();
  });

  it('goes back by itself after a reload when the microphone is already allowed', async () => {
    setNavigationType('reload');
    setMicrophone('granted');
    seedRecord();
    renderLobby();
    await waitFor(() => expect(tokenBodies).toHaveLength(1));
    expect(tokenBodies[0]).toMatchObject({ channelId: 'voice-1' });
  });

  it('waits for the click when the page was not reloaded', async () => {
    setMicrophone('granted');
    seedRecord();
    renderLobby();
    await screen.findByTestId('voice-resume-strip');
    await settle();
    expect(tokenBodies).toHaveLength(0);
  });

  it('does not offer a stale record, or a channel that is gone, and forgets them', async () => {
    seedRecord({ at: Date.now() - 5 * 60_000 });
    const { unmount } = renderLobby();
    await settle();
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();
    expect(stored()).toBeNull();
    unmount();

    seedRecord({ channelId: 'voice-deleted' });
    renderLobby();
    await settle();
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();
    expect(stored()).toBeNull();
  });

  it('stays out while another tab of this browser is in voice (a duplicated tab)', async () => {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(async () => undefined),
        query: async () => ({ held: [{ name: VOICE_LOCK_NAME, mode: 'exclusive' }] }),
      },
    });
    setNavigationType('reload');
    setMicrophone('granted');
    seedRecord();
    renderLobby();
    // A held lock gets a grace of 1.5 s (the reloaded page's own may still
    // be on record); this one stays held.
    await waitFor(() => expect(stored()).toBeNull(), { timeout: 4000 });
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();
    expect(tokenBodies).toHaveLength(0);
  });

  it('dismissing it forgets the way back', async () => {
    seedRecord();
    renderLobby();
    await screen.findByTestId('voice-resume-strip');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('voice-resume-strip')).toBeNull());
    expect(stored()).toBeNull();
  });

  it('leaving voice forgets it', async () => {
    seedRecord();
    renderLobby();
    await screen.findByTestId('voice-resume-strip');
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    await waitFor(() => expect(screen.queryByTestId('voice-resume-strip')).toBeNull());
    expect(stored()).toBeNull();
  });

  it('a voice block ends it: the server refused, nothing to go back to', async () => {
    tokenResponse = () => Response.json({ error: 'blocked', code: 'voice_blocked', retryAfter: 600 }, { status: 403 });
    seedRecord();
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to #Lounge' }));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('10 minutes'));
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();
    expect(stored()).toBeNull();
  });

  it('joining another channel ends the way back to the old one', async () => {
    seedRecord({ channelId: 'voice-2', channelName: 'Stage' });
    renderLobby();
    await screen.findByRole('button', { name: 'Back to #Stage' });
    fireEvent.click(screen.getByRole('button', { name: 'join voice-1' }));
    await waitFor(() => expect(tokenBodies).toHaveLength(1));
    expect(tokenBodies[0]).toMatchObject({ channelId: 'voice-1' });
    expect(stored()).toBeNull();
    // That join failed (503), and still nothing offers the old channel.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('idle:none'));
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();
  });
});

describe('the view after a reload', () => {
  it('reopens the activities view this tab was showing, and forgets it back in chat', async () => {
    window.sessionStorage.setItem(LOBBY_VIEW_KEY, JSON.stringify({ mode: 'activity', channelId: 'voice-2' }));
    renderLobby();
    await waitFor(() => expect(screen.getByTestId('view')).toHaveTextContent('activity:Stage'));
    expect(JSON.parse(window.sessionStorage.getItem(LOBBY_VIEW_KEY)!)).toEqual({ mode: 'activity', channelId: 'voice-2' });

    fireEvent.click(screen.getByRole('button', { name: 'to chat' }));
    await waitFor(() => expect(screen.getByTestId('view')).toHaveTextContent('chat:'));
    expect(window.sessionStorage.getItem(LOBBY_VIEW_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'open activities' }));
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(LOBBY_VIEW_KEY) ?? 'null')).toEqual({ mode: 'activity', channelId: 'voice-1' })
    );
  });

  it('opens the chat when the channel is gone', async () => {
    window.sessionStorage.setItem(LOBBY_VIEW_KEY, JSON.stringify({ mode: 'activity', channelId: 'voice-deleted' }));
    renderLobby();
    await settle();
    expect(screen.getByTestId('view')).toHaveTextContent('chat:-');
    expect(window.sessionStorage.getItem(LOBBY_VIEW_KEY)).toBeNull();
  });

  it('keeps the lobby strip out of the way while the activities view of that channel shows its own', async () => {
    window.sessionStorage.setItem(LOBBY_VIEW_KEY, JSON.stringify({ mode: 'activity', channelId: 'voice-1' }));
    seedRecord();
    renderLobby();
    await waitFor(() => expect(screen.getByTestId('view')).toHaveTextContent('activity:Lounge'));
    await settle();
    expect(screen.queryByTestId('voice-resume-strip')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'to chat' }));
    expect(await screen.findByTestId('voice-resume-strip')).toBeInTheDocument();
  });
});
