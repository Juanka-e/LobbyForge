'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * BlockListProvider — fetches the user's block list once and shares it
 * with every MemberBlockButton / popover in the lobby. Eliminates the
 * N+1 problem where each member row independently fetched the full
 * block list.
 */

interface BlockListContextValue {
  blockedIds: Set<string>;
  isBlocked: (userId: string) => boolean;
  /** Resolves false when the server refused or could not be reached (nothing changed). */
  toggleBlock: (userId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const BlockListContext = createContext<BlockListContextValue | null>(null);

export function BlockListProvider({ children }: { children: ReactNode }) {
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/me/blocks', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json()) as { blocks: Array<{ blockedUserId: string }> };
      setBlockedIds(new Set(data.blocks.map((b) => b.blockedUserId)));
    } catch {
      // Non-fatal — block buttons still work, just with stale state.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isBlocked = useCallback((userId: string) => blockedIds.has(userId), [blockedIds]);

  const toggleBlock = useCallback(async (userId: string) => {
    const wasBlocked = blockedIds.has(userId);
    try {
      if (wasBlocked) {
        const res = await fetch(`/api/settings/me/blocks/${userId}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`unblock failed: ${res.status}`);
      } else {
        const res = await fetch('/api/settings/me/blocks', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (!res.ok) throw new Error(`block failed: ${res.status}`);
      }
      setBlockedIds((prev) => {
        const next = new Set(prev);
        if (wasBlocked) next.delete(userId);
        else next.add(userId);
        return next;
      });
      return true;
    } catch {
      // State stays synced with server on failure; the caller says so.
      return false;
    }
  }, [blockedIds]);

  return (
    <BlockListContext.Provider value={{ blockedIds, isBlocked, toggleBlock, refresh }}>
      {children}
    </BlockListContext.Provider>
  );
}

export function useBlockList(): BlockListContextValue {
  const ctx = useContext(BlockListContext);
  if (!ctx) {
    // Fallback when no provider — a no-op context so components outside
    // the provider don't crash. One shared object: an effect that depends
    // on `blockedIds` must not rerun on every render.
    return NO_PROVIDER;
  }
  return ctx;
}

const NO_PROVIDER: BlockListContextValue = {
  blockedIds: new Set(),
  isBlocked: () => false,
  toggleBlock: async () => false,
  refresh: async () => {},
};
