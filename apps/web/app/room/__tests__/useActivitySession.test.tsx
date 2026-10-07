// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CONFLICT_MAX_ATTEMPTS } from '@/lib/activity-action-retry';
import { useActivitySession } from '../useActivitySession';

/**
 * Final-test finding: with several players acting at once, some saw
 * "Conflict: too many concurrent actions. Please retry." The hook now
 * retries that refusal itself, with the same actionId, and shows an error
 * only when every attempt failed.
 */

vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({ connect: () => {}, subscribe: () => () => {}, readyState: 1 }),
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

  it('says a network failure in words', async () => {
    actionAnswers = [() => {
      throw new TypeError('Failed to fetch');
    }];
    const { result } = await mountSession('tr');
    await act(async () => {
      await result.current.dispatch({ type: 'vote' });
    });
    expect(result.current.error).toBe('Sunucuya ulaşılamadı. Bağlantını kontrol et.');
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
