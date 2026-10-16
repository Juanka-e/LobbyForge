// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CONFLICT_MAX_ATTEMPTS, TRANSIENT_RETRY_WINDOW_MS } from '@/lib/activity-action-retry';
import { useActivitySession } from '../useActivitySession';

/**
 * Final-test finding: with several players acting at once, some saw
 * "Conflict: too many concurrent actions. Please retry." The hook now
 * retries that refusal itself, with the same actionId, and shows an error
 * only when every attempt failed.
 */

const realtime = vi.hoisted(() => ({
  reconnectListeners: new Set<() => void>(),
  liveListeners: new Set<() => void>(),
  handlers: new Map<string, (event: unknown) => void>(),
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    connect: () => {},
    subscribe: (topic: string, handler: (event: unknown) => void, options?: { onLive?: () => void }) => {
      realtime.handlers.set(topic, handler);
      if (options?.onLive) realtime.liveListeners.add(options.onLive);
      return () => {
        realtime.handlers.delete(topic);
        if (options?.onLive) realtime.liveListeners.delete(options.onLive);
      };
    },
    onReconnect: (listener: () => void) => {
      realtime.reconnectListeners.add(listener);
      return () => realtime.reconnectListeners.delete(listener);
    },
    readyState: 1,
  }),
}));

const SERVER = 'srv-1';
const SESSION = 'sess-1';
const ACTIONS = `/api/servers/${SERVER}/activities/${SESSION}/actions`;
const DETAIL = `/api/servers/${SERVER}/activities/${SESSION}`;
const CONFLICT = { error: 'Conflict: too many concurrent actions. Please retry.', revision: 4 };

let actionAnswers: Array<() => Response> = [];
let actionBodies: string[] = [];

beforeEach(() => {
  actionBodies = [];
  // The shortest backoff, so the suite stays fast.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === ACTIONS) {
        actionBodies.push(String(init.body));
        const answer = actionAnswers[Math.min(actionBodies.length - 1, actionAnswers.length - 1)]!;
        return answer();
      }
      if (url === DETAIL) {
        return Response.json({
          activity: { id: SESSION, pluginId: 'poll', status: 'running', state: { round: 1 }, createdBy: 'u1', players: [] },
        });
      }
      return Response.json({}, { status: 404 });
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function wrapper(locale: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider {...providerPropsFor(locale)}>{children}</I18nProvider>;
  };
}

async function mountSession(locale = 'en') {
  const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
    wrapper: wrapper(locale),
  });
  await waitFor(() => expect(hook.result.current.detail?.state).toEqual({ round: 1 }));
  return hook;
}

const conflict = () => Response.json(CONFLICT, { status: 409 });
const committed = () => Response.json({ activity: { state: { round: 2 }, status: 'running' } });

describe('useActivitySession dispatch under concurrent actions', () => {
  it('retries a conflict with the same actionId and shows no error', async () => {
    actionAnswers = [conflict, conflict, committed];
    const { result } = await mountSession();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.dispatch({ type: 'vote', option: 'a' });
    });

    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.detail?.state).toEqual({ round: 2 });
    expect(actionBodies).toHaveLength(3);
    expect(new Set(actionBodies).size).toBe(1);
    const sent = JSON.parse(actionBodies[0]!) as { actionId: string; type: string };
    expect(sent.type).toBe('vote');
    expect(sent.actionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows a friendly error only when every attempt failed', async () => {
    actionAnswers = [conflict];
    const { result } = await mountSession();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.dispatch({ type: 'vote', option: 'a' });
    });

    expect(ok).toBe(false);
    expect(actionBodies).toHaveLength(CONFLICT_MAX_ATTEMPTS);
    expect(result.current.error).toBe('Too many players acted at the same moment. Try again.');
    expect(result.current.busy).toBe(false);
  });

  it('says it in Turkish too', async () => {
    actionAnswers = [conflict];
    const { result } = await mountSession('tr');
    await act(async () => {
      await result.current.dispatch({ type: 'vote' });
    });
    expect(result.current.error).toBe('Aynı anda çok fazla oyuncu hamle yaptı. Yeniden dene.');
  });

  it('shows any other refusal at once, without retrying — translated, never the server’s English', async () => {
    actionAnswers = [() => Response.json({ error: 'Not the voting phase' }, { status: 409 })];
    const { result } = await mountSession();
    await act(async () => {
      await result.current.dispatch({ type: 'vote' });
    });
    expect(actionBodies).toHaveLength(1);
    expect(result.current.error).toBe("That didn't work (error 409). Try again.");
  });

  it.each([
    ['not_host', 403, 'en', 'Only the host can do that.'],
    ['voice_required', 403, 'en', 'Join the voice channel to play.'],
    ['voice_required', 403, 'tr', 'Oynamak için sesli kanala katıl.'],
    ['rate_limited', 429, 'en', "You're going too fast. Wait a moment and try again."],
    ['wrong_phase', 409, 'tr', 'Oyunun bu aşamasında bu yapılamaz.'],
  ])('says the %s refusal in the reader’s language (%s, %s)', async (code, status, locale, text) => {
    actionAnswers = [() => Response.json({ error: 'English from the server', code }, { status })];
    const { result } = await mountSession(locale);
    await act(async () => {
      await result.current.dispatch({ type: 'vote' });
    });
    expect(result.current.error).toBe(text);
  });

  it('hands the surface back when the session has ended', async () => {
    actionAnswers = [() => Response.json({ error: 'Activity has ended.', code: 'session_ended' }, { status: 409 })];
    const onEnded = vi.fn();
    const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(hook.result.current.detail?.state).toEqual({ round: 1 }), { timeout: 5000 });
    await act(async () => {
      await hook.result.current.dispatch({ type: 'vote' });
    });
    expect(hook.result.current.error).toBe('This activity has ended.');
    expect(onEnded).toHaveBeenCalled();
  });

  it('says a network failure in words, once the retry window is spent', async () => {
    actionAnswers = [() => {
      throw new TypeError('Failed to fetch');
    }];
    const { result } = await mountSession('tr');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.dispatch({ type: 'vote' });
      });
      // Busy (the button stays disabled) while it retries the same actionId.
      expect(result.current.busy).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_WINDOW_MS + 1_000);
        await pending;
      });
    } finally {
      vi.useRealTimers();
    }
    expect(actionBodies.length).toBeGreaterThan(1);
    expect(new Set(actionBodies).size).toBe(1);
    expect(result.current.error).toBe('Sunucuya ulaşılamadı. Bağlantını kontrol et.');
    expect(result.current.busy).toBe(false);
  });

  it('re-reads the session when a retry turns out to be a duplicate', async () => {
    actionAnswers = [conflict, () => Response.json({ error: 'Duplicate action — already processed.', duplicate: true }, { status: 409 })];
    const { result } = await mountSession();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.dispatch({ type: 'vote' });
    });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
    expect(actionBodies).toHaveLength(2);
  });
});

/**
 * Hosting moves lazily on the server, when somebody touches the session.
 * The hook re-reads once when a transfer (or abandonment) falls due, so it
 * happens without anyone acting — one timer re-armed per read, no loop.
 */
describe('useActivitySession host hand-over', () => {
  function stubDetails(answers: Array<() => Record<string, unknown>>) {
    const reads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url !== DETAIL) return Response.json({}, { status: 404 });
        reads.push(Date.now());
        const answer = answers[Math.min(reads.length - 1, answers.length - 1)]!;
        return Response.json({ activity: answer() });
      })
    );
    return reads;
  }

  const activity = (host: Record<string, unknown>, createdBy = 'u-old') => ({
    id: SESSION,
    pluginId: 'hushle',
    status: 'running',
    state: { phase: 'playing' },
    createdBy,
    players: [],
    host,
  });

  it('re-reads when the transfer is due and shows the new host, then stops', async () => {
    const reads = stubDetails([
      // The host left a minute ago: the transfer is already due.
      () =>
        activity({
          userId: 'u-old',
          inVoice: false,
          awaySince: new Date(Date.now() - 61_000).toISOString(),
          transferAt: new Date(Date.now() - 1_000).toISOString(),
          abandonAt: new Date(Date.now() + 119_000).toISOString(),
          abandoned: false,
        }),
      // The re-read made the server hand over.
      () => activity({ userId: 'u-new', inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false }, 'u-new'),
    ]);
    const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(hook.result.current.detail?.host?.inVoice).toBe(false), { timeout: 5000 });
    expect(reads).toHaveLength(1);

    await waitFor(() => expect(hook.result.current.detail?.createdBy).toBe('u-new'), { timeout: 6000 });
    expect(reads).toHaveLength(2);
    expect(hook.result.current.detail?.host).toMatchObject({ userId: 'u-new', inVoice: true });

    // The host is present now: nothing else is scheduled.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(reads).toHaveLength(2);
  }, 15_000);

  it('does not loop when the server could not hand over yet', async () => {
    const stuck = {
      userId: 'u-old',
      inVoice: false,
      awaySince: new Date(Date.now() - 61_000).toISOString(),
      transferAt: new Date(Date.now() - 1_000).toISOString(),
      abandonAt: new Date(Date.now() + 119_000).toISOString(),
      abandoned: false,
    };
    const reads = stubDetails([() => activity(stuck)]);
    renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(reads).toHaveLength(2), { timeout: 6000 });
    // Same past transferAt again: the next re-read waits for abandonment (minutes away).
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(reads).toHaveLength(2);
  }, 15_000);

  it('reads no host for a plugin that does not need voice, and schedules nothing', async () => {
    const reads = stubDetails([() => ({ id: SESSION, pluginId: 'poll', status: 'running', state: {}, createdBy: 'u1', players: [] })]);
    const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(hook.result.current.detail?.pluginId).toBe('poll'), { timeout: 5000 });
    expect(hook.result.current.detail?.host).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(reads).toHaveLength(1);
  }, 10_000);
});

/**
 * Plugin timers fire lazily too (lib/activity-timers.ts): the GET reports
 * when they fall due (never what they do) and the server's clock, and the
 * hook re-reads once at the earliest due time, counted on the server's clock.
 */
describe('useActivitySession plugin timers', () => {
  function stubDetails(answers: Array<() => Record<string, unknown>>) {
    const reads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === ACTIONS) {
          return Response.json({ activity: { state: { armed: true }, status: 'running', timersDueAt: [new Date(Date.now() + 60_000).toISOString()] } });
        }
        if (url !== DETAIL) return Response.json({}, { status: 404 });
        reads.push(Date.now());
        const answer = answers[Math.min(reads.length - 1, answers.length - 1)]!;
        return Response.json({ activity: answer() });
      })
    );
    return reads;
  }

  const activity = (extra: Record<string, unknown>) => ({
    id: SESSION,
    pluginId: 'sandbox-buzzer',
    status: 'running',
    state: { phase: 'open' },
    createdBy: 'u1',
    players: [],
    ...extra,
  });

  it('re-reads once at the earliest due time on the SERVER’s clock, then stops', async () => {
    // The server's clock runs 30 s ahead of this device: its timer is due in
    // half a second of server time, not in 30.5 s of device time.
    const skew = 30_000;
    const reads = stubDetails([
      () =>
        activity({
          now: new Date(Date.now() + skew).toISOString(),
          timersDueAt: [new Date(Date.now() + skew + 500).toISOString(), new Date(Date.now() + skew + 600_000).toISOString()],
        }),
      () => activity({ now: new Date(Date.now() + skew).toISOString(), timersDueAt: [new Date(Date.now() + skew + 600_000).toISOString()], state: { phase: 'revealed' } }),
    ]);
    const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(hook.result.current.detail?.timersDueAt).toHaveLength(2), { timeout: 5000 });
    expect(reads).toHaveLength(1);
    await waitFor(() => expect(hook.result.current.detail?.state).toEqual({ phase: 'revealed' }), { timeout: 6000 });
    expect(reads).toHaveLength(2);
    // The next timer is ten minutes away: nothing more for now.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(reads).toHaveLength(2);
  }, 15_000);

  it('two due times that stay pending do not make the panel re-read every 1.5 s (security review): it backs off', async () => {
    // The server keeps reporting two timers already due (it cannot fire them
    // yet). The old rule alternated between them: a read every 1.5 s, forever.
    const stuck = [new Date(Date.now() - 5_000).toISOString(), new Date(Date.now() - 2_000).toISOString()];
    const reads = stubDetails([() => activity({ now: new Date().toISOString(), timersDueAt: stuck })]);
    renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), { wrapper: wrapper('en') });
    await waitFor(() => expect(reads).toHaveLength(1));
    // One immediate re-read for them (after the 1.5 s margin) …
    await waitFor(() => expect(reads).toHaveLength(2), { timeout: 4_000 });
    // … then the next waits 2 s more (3.5 s): none at the old 1.5 s cadence.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(reads).toHaveLength(2);
  }, 15_000);

  it('a bus event saying the timers changed re-reads for the new due times', async () => {
    const reads = stubDetails([() => activity({ timersDueAt: [] })]);
    renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), { wrapper: wrapper('en') });
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => {
      realtime.handlers.get(`activity-state:${SERVER}:${SESSION}`)!({ status: 'running', revision: 5, publicSummary: { timersChanged: true } });
    });
    await waitFor(() => expect(reads).toHaveLength(2));
  });

  it('an action that sets a timer hands back its due time with the new state', async () => {
    stubDetails([() => activity({ timersDueAt: [] })]);
    const hook = renderHook(() => useActivitySession({ serverId: SERVER, sessionId: SESSION, onEnded: () => {} }), {
      wrapper: wrapper('en'),
    });
    await waitFor(() => expect(hook.result.current.detail?.timersDueAt).toEqual([]));
    await act(async () => {
      await hook.result.current.dispatch({ type: 'open-round' });
    });
    expect(hook.result.current.detail?.state).toEqual({ armed: true });
    expect(hook.result.current.detail?.timersDueAt).toHaveLength(1);
  });
});

describe('useActivitySession realtime frame order (G4)', () => {
  const TOPIC = `activity-state:${SERVER}:${SESSION}`;
  const frame = (data: Record<string, unknown>) =>
    act(() => {
      realtime.handlers.get(TOPIC)!(data);
    });

  it('ignores a frame older than the revision it already shows', async () => {
    const { result } = await mountSession();
    frame({ status: 'running', revision: 5, state: { round: 5 } });
    expect(result.current.detail?.state).toEqual({ round: 5 });
    // A late frame from before: left out.
    frame({ status: 'running', revision: 4, state: { round: 4 } });
    expect(result.current.detail?.state).toEqual({ round: 5 });
    // The same revision again, or a newer one, applies.
    frame({ status: 'running', revision: 5, state: { round: 5, again: true } });
    expect(result.current.detail?.state).toEqual({ round: 5, again: true });
    frame({ status: 'finished', revision: 6, state: { round: 6 } });
    expect(result.current.detail?.state).toEqual({ round: 6 });
    expect(result.current.detail?.status).toBe('finished');
  });

  it('applies a frame without a revision as before (older gateways)', async () => {
    const { result } = await mountSession();
    frame({ status: 'running', revision: 5, state: { round: 5 } });
    frame({ status: 'running', state: { round: 7 } });
    expect(result.current.detail?.state).toEqual({ round: 7 });
  });
});

describe('useActivitySession catching up after the connection was away', () => {
  const detailReads = () =>
    (fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.filter(([url]) => url === DETAIL).length;

  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  it('re-reads the session when its topic goes live — first, and after a reconnect (events before were never sent)', async () => {
    const { unmount } = await mountSession();
    const before = detailReads();
    act(() => {
      for (const listener of realtime.liveListeners) listener();
    });
    await waitFor(() => expect(detailReads()).toBe(before + 1));
    unmount();
    expect(realtime.liveListeners.size).toBe(0);
  });

  it('re-reads when the network comes back', async () => {
    await mountSession();
    const before = detailReads();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(detailReads()).toBe(before + 1));
  });

  it('re-reads when the tab is shown after a while in the background, not after a quick switch', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await mountSession();
    const before = detailReads();
    const flip = (state: DocumentVisibilityState, at: number) => {
      now.mockReturnValue(at);
      visibility = state;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    flip('hidden', 1_000_000);
    flip('visible', 1_002_000);
    expect(detailReads()).toBe(before);
    flip('hidden', 1_010_000);
    flip('visible', 1_040_000);
    await waitFor(() => expect(detailReads()).toBe(before + 1));
  });

  it('lands a tap made while the network blinked, without an error', async () => {
    actionAnswers = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      committed,
    ];
    const { result } = await mountSession();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.dispatch({ type: 'vote', option: 'a' });
    });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
    expect(actionBodies).toHaveLength(2);
    expect(new Set(actionBodies).size).toBe(1);
  });
});
