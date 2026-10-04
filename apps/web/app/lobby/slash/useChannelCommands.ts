'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchChannelCommands } from '@/lib/bots/client-api';
import type { ChannelCommand } from '@/lib/bots/command-options';

export interface ChannelCommandsState {
  commands: ChannelCommand[];
  status: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * The commands the member may run in a channel, loaded the first time the
 * composer needs them (`active`) and shared through the per-channel cache
 * in `client-api` — typing `/` again does not refetch.
 */
export function useChannelCommands(
  serverId: string | null,
  channelId: string | null,
  active: boolean
): ChannelCommandsState & { reload: () => void } {
  const [state, setState] = useState<ChannelCommandsState & { key: string | null }>({
    commands: [],
    status: 'idle',
    key: null,
  });
  const [attempt, setAttempt] = useState(0);
  const key = serverId && channelId ? `${serverId}:${channelId}` : null;
  const stale = state.key !== key;

  useEffect(() => {
    if (!active || !serverId || !channelId || !key) return;
    let cancelled = false;
    setState((current) =>
      current.key === key && current.status === 'ready' && attempt === 0
        ? current
        : { commands: current.key === key ? current.commands : [], status: 'loading', key }
    );
    void fetchChannelCommands(serverId, channelId, { force: attempt > 0 }).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { commands: result.data, status: 'ready', key } : { commands: [], status: 'error', key });
    });
    return () => {
      cancelled = true;
    };
  }, [active, serverId, channelId, key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { commands: stale ? [] : state.commands, status: stale ? 'idle' : state.status, reload };
}
