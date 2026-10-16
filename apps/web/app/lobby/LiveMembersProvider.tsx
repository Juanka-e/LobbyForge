'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { invalidateMemberProfile } from '@/lib/member-profile';
import { compareLobbyMembers, type LobbyMember } from '@/lib/lobby-members';

/**
 * The lobby's member rows, kept live (docs/PROFILES.md "Live updates").
 *
 * The page render hands over the first list. After that, `members:{serverId}`
 * events say WHO changed — joined, left, new roles, a new name or avatar — and
 * this provider re-reads exactly those rows from
 * `GET /api/servers/{id}/lobby-members`, projected for this viewer. A role
 * edit re-reads everyone, and so does the topic going live — once the
 * gateway confirms it, which is after the page was rendered (a change in
 * between was never sent here), and again after every reconnect.
 *
 * Status and presence are not this provider's: the member list keeps them
 * from the presence feed, and a re-read row keeps the ones it had.
 */

export interface LiveMembersValue {
  members: LobbyMember[];
  /**
   * How many times each member's row was re-read or removed live. A reader
   * that holds something derived from a row (a cached profile card, a role
   * overlay) drops it when the number moves.
   */
  versions: ReadonlyMap<string, number>;
}

const LiveMembersContext = createContext<LiveMembersValue | null>(null);

/** The live member rows, or null outside the live lobby (demo mode, tests). */
export function useLiveMembers(): LiveMembersValue | null {
  return useContext(LiveMembersContext);
}

/** Bursts (a role handed to ten people) are read in one request. */
const COALESCE_MS = 300;
/** More named ids than this are read as the whole list (the route's cap is 100). */
const MAX_IDS_PER_READ = 100;

type MemberEvent =
  | { type: 'members-changed' | 'members-removed'; userIds: string[] }
  | { type: 'roles-changed' };

function parseEvent(data: unknown): MemberEvent | null {
  if (!data || typeof data !== 'object') return null;
  const { type, userIds } = data as { type?: unknown; userIds?: unknown };
  if (type === 'roles-changed') return { type };
  if ((type === 'members-changed' || type === 'members-removed') && Array.isArray(userIds)) {
    const ids = userIds.filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? { type, userIds: ids } : null;
  }
  return null;
}

/** Fresh rows keep the live status and presence the list already had. */
function withLiveStatus(row: LobbyMember, previous: LobbyMember | undefined): LobbyMember {
  if (!previous) return row;
  return { ...row, status: previous.status, presence: previous.presence, grayscale: previous.grayscale, muted: previous.muted };
}

export function LiveMembersProvider({
  serverId,
  initialMembers,
  children,
}: {
  serverId: string;
  initialMembers: LobbyMember[];
  children: ReactNode;
}) {
  const [members, setMembers] = useState<LobbyMember[]>(initialMembers);
  const [versions, setVersions] = useState<ReadonlyMap<string, number>>(() => new Map());
  const pendingIds = useRef(new Set<string>());
  const pendingFull = useRef(false);
  const timer = useRef<number | null>(null);

  // A new page render (another community, a refresh) starts over.
  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);

  useEffect(() => {
    let disposed = false;
    const bump = (ids: Iterable<string>) => {
      setVersions((current) => {
        const next = new Map(current);
        for (const id of ids) next.set(id, (next.get(id) ?? 0) + 1);
        return next;
      });
    };

    const read = async () => {
      timer.current = null;
      const full = pendingFull.current || pendingIds.current.size > MAX_IDS_PER_READ;
      const ids = [...pendingIds.current];
      pendingFull.current = false;
      pendingIds.current.clear();
      if (!full && ids.length === 0) return;
      const query = full ? '' : `?ids=${ids.map(encodeURIComponent).join(',')}`;
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/lobby-members${query}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok || disposed) return;
        const body = (await res.json()) as { members?: LobbyMember[]; missing?: string[] };
        if (disposed || !Array.isArray(body.members)) return;
        const rows = body.members;
        const missing = new Set(Array.isArray(body.missing) ? body.missing : []);
        setMembers((previous) => {
          const before = new Map(previous.map((member) => [member.id, member]));
          if (full) return rows.map((row) => withLiveStatus(row, before.get(row.id))).sort(compareLobbyMembers);
          const fresh = new Map(rows.map((row) => [row.id, row]));
          const next = previous
            .filter((member) => !missing.has(member.id))
            .map((member) => {
              const row = fresh.get(member.id);
              return row ? withLiveStatus(row, member) : member;
            });
          for (const row of rows) if (!before.has(row.id)) next.push(row);
          return next.sort(compareLobbyMembers);
        });
        if (full) invalidateMemberProfile(serverId);
        const touched = full ? rows.map((row) => row.id) : ids;
        if (!full) for (const id of ids) invalidateMemberProfile(serverId, id);
        bump(touched);
      } catch {
        // The next event, or the next reconnect, reads again.
      }
    };

    const schedule = () => {
      if (timer.current === null) timer.current = window.setTimeout(() => void read(), COALESCE_MS);
    };

    const client = getRealtimeClient();
    const unsubscribe = client.subscribe(
      `members:${serverId}`,
      (data) => {
        const event = parseEvent(data);
        if (!event) return;
        if (event.type === 'members-removed') {
          const gone = new Set(event.userIds);
          for (const id of gone) {
            pendingIds.current.delete(id);
            invalidateMemberProfile(serverId, id);
          }
          setMembers((previous) => previous.filter((member) => !gone.has(member.id)));
          bump(gone);
          return;
        }
        if (event.type === 'roles-changed') pendingFull.current = true;
        else for (const id of event.userIds) pendingIds.current.add(id);
        schedule();
      },
      {
        // Live from here on: whatever changed since the page was rendered,
        // or while the socket was down, was never sent — read everyone.
        onLive: () => {
          pendingFull.current = true;
          schedule();
        },
      }
    );
    return () => {
      disposed = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      pendingIds.current.clear();
      pendingFull.current = false;
      unsubscribe();
    };
  }, [serverId]);

  const value = useMemo(() => ({ members, versions }), [members, versions]);
  return <LiveMembersContext.Provider value={value}>{children}</LiveMembersContext.Provider>;
}

/** The provider in the live lobby (a server id), nothing around the demo lobby. */
export function LiveMembersBoundary({
  serverId,
  initialMembers,
  children,
}: {
  serverId: string | null | undefined;
  initialMembers: LobbyMember[];
  children: ReactNode;
}) {
  if (!serverId) return <>{children}</>;
  return (
    <LiveMembersProvider serverId={serverId} initialMembers={initialMembers}>
      {children}
    </LiveMembersProvider>
  );
}
