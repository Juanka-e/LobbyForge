'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { postActivityAction } from '@/lib/activity-action-retry';
import { activityRefusalMessage, parseActivityRefusal } from '@/lib/activity-refusal';
import { nextHostCheck, parseActivityHost, type ActivityHostState } from '@/lib/activity-host-view';
import { useT } from '@/lib/i18n/client';

/**
 * Live state for one activity session, shared by every surface that
 * shows a game: the voice room panel and the lobby's activities view.
 *
 * The transport rules here are load-bearing and were both beta-review
 * bugs, which is why they live in one place instead of being written
 * twice:
 *
 *  - A realtime subscription delivers only FUTURE events, so the
 *    initial state MUST be fetched on mount. Without it a host who had
 *    just started a game stared at an empty panel until somebody else
 *    dispatched an action.
 *  - `connect()` is asynchronous, so reading `readyState` immediately
 *    after it always sees CONNECTING and never CLOSED — the polling
 *    fallback could never engage. It is re-checked on a timer instead,
 *    and stops once the socket is open.
 *  - When several players act at once, the server can refuse some of
 *    them with a retryable 409. `dispatch` retries those itself, with the
 *    same `actionId` (see `lib/activity-action-retry.ts`), and shows an
 *    error only when every attempt failed.
 */

export interface ActivityDetail {
  id: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  /** The host: the creator until hosting moves (the server reports the current one). */
  createdBy: string | null;
  players: Array<{ userId: string; name?: string | null; status: string; score: number }>;
  /** Where the host stands, for games played over voice; absent otherwise. */
  host?: ActivityHostState | null;
}

/** A session GET body's `activity`, with `host` read defensively. */
function toDetail(raw: ActivityDetail & { host?: unknown }): ActivityDetail {
  return { ...raw, host: parseActivityHost(raw.host) };
}

const POLL_INTERVAL_MS = 5_000;
const TRANSPORT_CHECK_MS = 5_000;
const TRANSPORT_FIRST_CHECK_MS = 1_500;

export function useActivitySession({
  serverId,
  sessionId,
  onEnded,
}: {
  serverId: string | null;
  sessionId: string | null;
  /** Called when the session no longer exists (ended elsewhere). */
  onEnded: () => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `onEnded` is usually an inline arrow; keep it out of the effect deps
  // so a parent re-render doesn't tear down the subscription.
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // The subscription effect reads the translator without re-subscribing
  // when the language changes.
  const tRef = useRef(t);
  tRef.current = t;
  // The current subscription's re-read, for the host timer below.
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  // The due time the host timer last re-read for (see nextHostCheck).
  const hostFiredForRef = useRef<number | null>(null);

  /**
   * A refusal as a sentence in the reader's language (never the server's
   * English `error`). An ended session also hands the surface back to
   * whoever shows the picker, so the message is the last thing it shows.
   */
  const refuse = useCallback((status: number, code: string | null) => {
    const message = activityRefusalMessage({ status, code }, 'session');
    setError(t(message.key, message.params));
    if (code === 'session_ended') onEndedRef.current();
  }, [t]);

  useEffect(() => {
    if (!serverId || !sessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollFallback = false;
    let unsubscribe: (() => void) | null = null;

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/servers/${serverId}/activities/${sessionId}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status === 404) {
          if (!cancelled) {
            // Gone for an ordinary reason: an older refusal ("Only the
            // host can do that.") must not outlive the session.
            setError(null);
            onEndedRef.current();
          }
          return;
        }
        if (!res.ok) {
          if (!cancelled) setError(tRef.current('room.activity.error.load', { status: res.status }));
          return;
        }
        const data = (await res.json()) as { activity: ActivityDetail };
        if (!cancelled) {
          setDetail(toDetail(data.activity));
          setError(null);
        }
      } catch {
        if (!cancelled) setError(tRef.current('room.activity.error.network'));
      }
    };
    refreshRef.current = fetchOnce;
    hostFiredForRef.current = null;

    const handleEvent = (raw: unknown) => {
      if (cancelled || !raw || typeof raw !== 'object') return;
      const event = raw as Partial<ActivityDetail> & { type?: string; host?: unknown };
      if (event.type === 'snapshot' || event.id) {
        setDetail((prev) => ({
          id: event.id ?? '',
          pluginId: event.pluginId ?? '',
          status: event.status ?? '',
          state: event.state ?? {},
          createdBy: event.createdBy ?? null,
          players: Array.isArray(event.players) ? event.players : [],
          // A snapshot without `host` keeps the last one the GET reported.
          host: 'host' in event ? parseActivityHost(event.host) : (prev?.host ?? null),
        }));
        return;
      }
      if (event.status && event.state) {
        setDetail((prev) =>
          prev ? { ...prev, status: event.status as string, state: event.state as Record<string, unknown> } : prev
        );
      }
      // Someone new acted: the event carries no identities, so re-read the
      // session for the player list (with names) the panel shows. Also
      // re-read when a change arrives WITHOUT state: the gateway sends the
      // event stateless when it could not project it for this viewer (a
      // sandboxed plugin's projection call failed), and the panel must not
      // sit on the old state until the next action.
      const summary = (raw as { publicSummary?: { rosterChanged?: unknown } }).publicSummary;
      if (summary?.rosterChanged === true || (event.status && !event.state)) void fetchOnce();
    };

    void fetchOnce();

    try {
      const client = getRealtimeClient();
      client.connect();
      unsubscribe = client.subscribe(`activity-state:${serverId}:${sessionId}` as const, handleEvent);
    } catch {
      pollFallback = true;
    }

    const ensureTransport = () => {
      if (cancelled) return;
      let open = false;
      try {
        open = !pollFallback && getRealtimeClient().readyState === WebSocket.OPEN;
      } catch {
        open = false;
      }
      if (open) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }
      if (!pollTimer) pollTimer = setInterval(() => void fetchOnce(), POLL_INTERVAL_MS);
    };
    const firstCheck = setTimeout(ensureTransport, TRANSPORT_FIRST_CHECK_MS);
    const transportTimer = setInterval(ensureTransport, TRANSPORT_CHECK_MS);

    return () => {
      cancelled = true;
      if (refreshRef.current === fetchOnce) refreshRef.current = null;
      unsubscribe?.();
      clearTimeout(firstCheck);
      clearInterval(transportTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [serverId, sessionId]);

  // Hosting moves (and a session becomes abandoned) lazily, when somebody
  // touches the session. Re-read once at the earliest due moment so the
  // hand-over happens even if nobody acts. Re-armed after every read (each
  // read gives a new `host`); never a polling loop (see nextHostCheck).
  const host = detail?.host ?? null;
  useEffect(() => {
    const next = nextHostCheck(host, Date.now(), hostFiredForRef.current);
    if (!next) return;
    const timer = setTimeout(() => {
      hostFiredForRef.current = next.at;
      void refreshRef.current?.();
    }, next.delay);
    return () => clearTimeout(timer);
  }, [host]);

  const dispatch = useCallback(
    async (action: Record<string, unknown>): Promise<boolean> => {
      if (!serverId || !sessionId) return false;
      setBusy(true);
      setError(null);
      try {
        const result = await postActivityAction(
          `/api/servers/${serverId}/activities/${sessionId}/actions`,
          // LF-002: one idempotency key per dispatch. Every automatic retry
          // of a concurrency conflict reuses it, so the action runs once.
          { actionId: crypto.randomUUID(), ...action }
        );
        if (result.kind === 'duplicate') {
          // The action was already committed by an earlier attempt; there
          // is no response replay, so re-read instead of showing an error.
          const current = await fetch(`/api/servers/${serverId}/activities/${sessionId}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          });
          if (current.ok) {
            const data = (await current.json()) as { activity: ActivityDetail };
            setDetail(toDetail(data.activity));
          }
          return true;
        }
        if (result.kind === 'error') {
          // A conflict gets here only once every retry lost the race too.
          if (result.conflict) setError(t('room.activity.conflict'));
          else refuse(result.status, result.code);
          return false;
        }
        const data = result.data as { activity: { state: Record<string, unknown>; status: string } };
        setDetail((prev) =>
          prev ? { ...prev, state: data.activity.state, status: data.activity.status } : prev
        );
        return true;
      } catch {
        // fetch itself failed: no answer from the server at all.
        setError(t('room.activity.error.network'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [serverId, sessionId, t, refuse]
  );

  const end = useCallback(async (): Promise<boolean> => {
    if (!serverId || !sessionId) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/activities/${sessionId}/end`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const refusal = parseActivityRefusal(res.status, await res.json().catch(() => ({})));
        refuse(refusal.status, refusal.code);
        return false;
      }
      onEndedRef.current();
      return true;
    } catch {
      setError(t('room.activity.error.network'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [serverId, sessionId, t, refuse]);

  return { detail, error, busy, setError, dispatch, end };
}

/**
 * The open activity in a channel, if there is one. A channel holds at
 * most one, so every viewer joins the same session rather than being
 * offered a picker that would answer 409.
 */
export async function findOpenActivity(
  serverId: string,
  channelId: string
): Promise<{ id: string; pluginId: string } | null> {
  try {
    const res = await fetch(`/api/servers/${serverId}/channels/${channelId}/activities`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      activities?: Array<{ id: string; pluginId: string; status: string }>;
    };
    const open = data.activities?.find((a) => a.status !== 'ended' && a.status !== 'cancelled');
    return open ? { id: open.id, pluginId: open.pluginId } : null;
  } catch {
    return null;
  }
}
