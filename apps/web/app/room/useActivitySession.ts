'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';

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
 */

export interface ActivityDetail {
  id: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  createdBy: string | null;
  players: Array<{ userId: string; name?: string | null; status: string; score: number }>;
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
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `onEnded` is usually an inline arrow; keep it out of the effect deps
  // so a parent re-render doesn't tear down the subscription.
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

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
          if (!cancelled) onEndedRef.current();
          return;
        }
        if (!res.ok) throw new Error(`Could not load the activity (${res.status})`);
        const data = (await res.json()) as { activity: ActivityDetail };
        if (!cancelled) {
          setDetail(data.activity);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };

    const handleEvent = (raw: unknown) => {
      if (cancelled || !raw || typeof raw !== 'object') return;
      const event = raw as Partial<ActivityDetail> & { type?: string };
      if (event.type === 'snapshot' || event.id) {
        setDetail({
          id: event.id ?? '',
          pluginId: event.pluginId ?? '',
          status: event.status ?? '',
          state: event.state ?? {},
          createdBy: event.createdBy ?? null,
          players: Array.isArray(event.players) ? event.players : [],
        });
        return;
      }
      if (event.status && event.state) {
        setDetail((prev) =>
          prev ? { ...prev, status: event.status as string, state: event.state as Record<string, unknown> } : prev
        );
      }
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
      unsubscribe?.();
      clearTimeout(firstCheck);
      clearInterval(transportTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [serverId, sessionId]);

  const dispatch = useCallback(
    async (action: Record<string, unknown>): Promise<boolean> => {
      if (!serverId || !sessionId) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/servers/${serverId}/activities/${sessionId}/actions`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          // LF-002: a fresh idempotency key per dispatch, so a transport
          // retry of THIS request is de-duplicated server-side.
          body: JSON.stringify({ actionId: crypto.randomUUID(), ...action }),
        });
        if (res.status === 409) {
          // The action was already committed by an earlier attempt; there
          // is no response replay, so re-read instead of showing an error.
          const conflict = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
          if (conflict.duplicate) {
            const current = await fetch(`/api/servers/${serverId}/activities/${sessionId}`, {
              credentials: 'same-origin',
              cache: 'no-store',
            });
            if (current.ok) {
              const data = (await current.json()) as { activity: ActivityDetail };
              setDetail(data.activity);
            }
            return true;
          }
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `The action was rejected (${res.status})`);
        }
        const data = (await res.json()) as { activity: { state: Record<string, unknown>; status: string } };
        setDetail((prev) =>
          prev ? { ...prev, state: data.activity.state, status: data.activity.status } : prev
        );
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [serverId, sessionId]
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
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not end the activity (${res.status})`);
      }
      onEndedRef.current();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [serverId, sessionId]);

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
