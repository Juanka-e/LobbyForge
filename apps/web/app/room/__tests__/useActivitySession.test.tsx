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

  it('shows any other refusal at once, without retrying', async () => {
    actionAnswers = [() => Response.json({ error: 'Activity has ended.' }, { status: 409 })];
    const { result } = await mountSession();
    await act(async () => {
      await result.current.dispatch({ type: 'vote' });
    });
    expect(actionBodies).toHaveLength(1);
    expect(result.current.error).toBe('Activity has ended.');
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
