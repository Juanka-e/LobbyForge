'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { UserProfilePopover } from '@/components/modals/UserProfilePopover';
import { MemberBlockButton } from './MemberBlockButton';

/**
 * Real-time members panel. Subscribes to presence WS topic + polls as
 * fallback. Renders LobbyMemberItem rows with shared popover state so
 * only one profile popover can be open at a time.
 */

interface Member {
  id: string;
  name: string;
  status: 'in-voice' | 'online' | 'offline';
  muted?: boolean;
  grayscale?: boolean;
  roleName?: string | null;
  roleColor?: string | null;
  isGuest?: boolean;
  avatarUrl?: string | null;
}

interface PresenceEntry {
  userId: string;
  channelId: string;
  status?: string;
  lastSeen: number;
}

interface ApiSnapshot {
  presences: PresenceEntry[];
}

const POLL_FALLBACK_MS = 15_000;

function deriveStatus(
  p: { channelId: string; lastSeen: number },
  voiceChannelIds: Set<string>,
  now: number = Date.now()
): Member['status'] {
  if (now - p.lastSeen > 90_000) return 'offline';
  if (p.channelId && voiceChannelIds.has(p.channelId)) return 'in-voice';
  return 'online';
}

export function LobbyMembersClient({
  serverId,
  initialMembers,
  voiceChannelIds,
  currentUserId,
}: {
  serverId: string;
  initialMembers: Member[];
  voiceChannelIds: string[];
  currentUserId: string | null;
}) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const voiceChannelIdsRef = useRef(new Set(voiceChannelIds));
  voiceChannelIdsRef.current = new Set(voiceChannelIds);

  // Shared popover state — only one popover can be open at a time.
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // WS presence subscribe
  useEffect(() => {
    const topic = `presence:${serverId}` as const;
    const rc = getRealtimeClient();
    const unsubscribe = rc.subscribe<{ userId: string; status: string; channelId: string; lastSeen: number }>(topic, (event) => {
      if (!event || !event.userId) return;
      setMembers((prev) => {
        const status = deriveStatus(event, voiceChannelIdsRef.current);
        return prev.map((m) =>
          m.id === event.userId ? { ...m, status, grayscale: status === 'offline' || undefined } : m
        );
      });
    });
    return () => { unsubscribe(); };
  }, [serverId]);

  // Polling fallback
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/presence?serverId=${encodeURIComponent(serverId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as ApiSnapshot;
      if (!data.presences) return;
      const now = Date.now();
      const presenceByUser = new Map<string, PresenceEntry>();
      for (const p of data.presences) presenceByUser.set(p.userId, p);
      setMembers((prev) =>
        prev
          .map((m) => {
            const p = presenceByUser.get(m.id);
            const status = p ? deriveStatus(p, voiceChannelIdsRef.current, now) : 'offline';
            return { ...m, status, grayscale: status === 'offline' || undefined };
          })
          .sort((a, b) => {
            const order: Record<Member['status'], number> = { 'in-voice': 0, online: 1, offline: 2 };
            return order[a.status] - order[b.status] || a.name.localeCompare(b.name);
          })
      );
    } catch { /* next poll retries */ }
  }, [serverId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, POLL_FALLBACK_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const online = members.filter((m) => m.status === 'online' || m.status === 'in-voice');
  const offline = members.filter((m) => m.status === 'offline');
  const openMember = members.find((m) => m.id === openUserId);

  function openPopover(m: Member, rect: DOMRect) {
    setAnchorRect(rect);
    setOpenUserId(m.id);
  }

  return (
    <>
      <aside className="w-[200px] lg:w-[230px] flex-shrink-0 bg-surface-dim border-l border-border-subtle hidden lg:flex flex-col h-full z-20 overflow-y-auto p-4 animate-fade-in-left">
        {members.length === 0 ? (
          <p className="font-label-xs text-text-muted italic">No members yet.</p>
        ) : null}
        <MemberSection label={`Online — ${online.length}`} members={online} currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
        <MemberSection label={`Offline — ${offline.length}`} members={offline} dimmed currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
      </aside>
      {openMember ? (
        <UserProfilePopover
          open={true}
          onClose={() => setOpenUserId(null)}
          anchorRect={anchorRect}
          user={{
            userId: openMember.id,
            displayName: openMember.name,
            avatarUrl: openMember.avatarUrl ?? null,
            isGuest: openMember.isGuest ?? false,
            roleName: openMember.roleName,
            roleColor: openMember.roleColor,
            onlineStatus: openMember.status === 'in-voice' ? 'in_voice' : openMember.status,
          }}
        />
      ) : null}
    </>
  );
}

function MemberSection({
  label,
  members,
  dimmed,
  currentUserId,
  openUserId,
  onOpen,
  onClosePopover,
}: {
  label: string;
  members: Member[];
  dimmed?: boolean;
  currentUserId: string | null;
  openUserId: string | null;
  onOpen: (m: Member, rect: DOMRect) => void;
  onClosePopover: () => void;
}) {
  if (members.length === 0) return null;
  return (
    <div className="mb-6">
      <h3
        className={
          dimmed
            ? 'font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 opacity-70 text-text-secondary'
            : 'font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 text-text-secondary'
        }
      >
        <span>{label}</span>
        <div className="h-[1px] flex-1 bg-border-subtle" />
      </h3>
      <ul className={dimmed ? 'space-y-1 opacity-60' : 'space-y-1'}>
        {members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            currentUserId={currentUserId}
            isOpen={openUserId === m.id}
            onOpen={(rect) => onOpen(m, rect)}
            onClose={onClosePopover}
          />
        ))}
      </ul>
    </div>
  );
}

function MemberRow({
  member,
  currentUserId,
  isOpen,
  onOpen,
  onClose,
}: {
  member: Member;
  currentUserId: string | null;
  isOpen: boolean;
  onOpen: (rect: DOMRect) => void;
  onClose: () => void;
}) {
  const roleColor = member.roleColor || undefined;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (isOpen) {
      onClose();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    onOpen(rect);
  }

  return (
    <li>
      <div
        className={
          member.status === 'in-voice'
            ? 'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-container/50 group'
            : 'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-container/50 group opacity-80'
        }
      >
        <button
          type="button"
          data-user-popover-anchor
          onClick={handleClick}
          className="min-w-0 flex flex-1 items-center gap-3 text-left"
        >
          <div
            className={
              member.grayscale
                ? 'w-8 h-8 rounded-full bg-secondary-container relative grayscale flex-shrink-0 overflow-hidden'
                : 'w-8 h-8 rounded-full bg-secondary-container relative flex-shrink-0 overflow-hidden'
            }
            style={roleColor ? { boxShadow: `0 0 0 2px ${roleColor}` } : undefined}
          >
            {member.avatarUrl ? (
              <img src={member.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-label-sm font-bold text-text-primary">
                {member.name.charAt(0).toUpperCase()}
              </span>
            )}
            {member.status !== 'offline' ? (
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-surface-dim" />
            ) : (
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-surface-container border-2 border-surface-dim flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-text-muted" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex flex-col">
            <span
              className={
                member.status === 'in-voice'
                  ? 'font-label-sm text-text-primary font-medium truncate'
                  : 'font-label-sm text-text-secondary truncate'
              }
              style={roleColor ? { color: roleColor } : undefined}
            >
              {member.name}
            </span>
            {member.roleName ? (
              <span
                className="text-[10px] font-medium truncate"
                style={roleColor ? { color: roleColor, opacity: 0.8 } : { color: '#7F8A99' }}
              >
                {member.roleName}
              </span>
            ) : member.isGuest ? (
              <span className="text-[10px] text-text-muted font-medium truncate">Guest</span>
            ) : null}
          </div>
        </button>
        {member.muted ? (
          <span className="material-symbols-outlined text-[16px] text-text-secondary">mic_off</span>
        ) : null}
        <MemberBlockButton userId={member.id} isSelf={member.id === currentUserId} />
      </div>
    </li>
  );
}
