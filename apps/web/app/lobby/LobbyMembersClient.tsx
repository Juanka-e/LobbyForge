'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { UserProfilePopover } from '@/components/modals/UserProfilePopover';
import { MemberBlockButton } from './MemberBlockButton';
import { useLobbyVoice } from './LobbyVoiceProvider';
import { useBlockList } from './BlockListProvider';
import {
  PRESENCE_DOT_CLASS,
  PRESENCE_LABELS,
  toPresenceStatus,
  type PresenceStatus,
} from '@/lib/presence-status';

/**
 * Real-time members panel. Subscribes to presence WS topic + polls as
 * fallback. Renders LobbyMemberItem rows with shared popover state so
 * only one profile popover can be open at a time.
 */

interface Member {
  id: string;
  name: string;
  status: 'in-voice' | 'online' | 'offline';
  /** The status the member chose (drives the dot color). */
  presence?: PresenceStatus;
  muted?: boolean;
  grayscale?: boolean;
  roleName?: string | null;
  roleColor?: string | null;
  isGuest?: boolean;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  statusText?: string | null;
  bio?: string | null;
  roles?: Array<{ id: string; name: string; color: string | null; icon: string | null; position: number; displaySeparately: boolean }>;
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
/** beta-review (S5): minimum gap between event-driven presence re-fetches. */
const PRESENCE_EVENT_REFETCH_MS = 5_000;

function deriveStatus(
  p: { channelId: string | null; lastSeen: number; status?: string },
  voiceChannelIds: Set<string>,
  now: number = Date.now()
): Member['status'] {
  // beta-review: honor "online status: nobody/friends" — the projection
  // returns status 'hidden' (and lastSeen 0) for those users.
  if (p.status === 'hidden') return 'offline';
  // beta-review: a member who picked "Invisible" sends status 'offline'
  // on every heartbeat; they must read as offline, not merely present.
  if (p.status === 'offline') return 'offline';
  if (now - p.lastSeen > 90_000) return 'offline';
  if (p.channelId && voiceChannelIds.has(p.channelId)) return 'in-voice';
  return 'online';
}

/** The dot color: the chosen status, or offline once the row is stale. */
function derivePresence(
  p: { lastSeen: number; status?: string },
  now: number = Date.now()
): PresenceStatus {
  if (p.status === 'hidden' || now - p.lastSeen > 90_000) return 'offline';
  return toPresenceStatus(p.status);
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
  const voice = useLobbyVoice();
  const blockList = useBlockList();
  const voiceChannelIdsRef = useRef(new Set(voiceChannelIds));
  voiceChannelIdsRef.current = new Set(voiceChannelIds);

  // Shared popover state — only one popover can be open at a time.
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

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
            const presence = p ? derivePresence(p, now) : 'offline';
            return { ...m, status, presence, grayscale: status === 'offline' || undefined };
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

  // WS presence subscribe. beta-review (S5): the event is a content-free
  // "presence changed" signal — re-fetch the per-viewer REST snapshot
  // (privacy, blocks and channel visibility applied server-side) instead
  // of reading any payload. Bursts coalesce into one trailing fetch at
  // most every PRESENCE_EVENT_REFETCH_MS.
  useEffect(() => {
    const topic = `presence:${serverId}` as const;
    const rc = getRealtimeClient();
    let timer: number | null = null;
    let lastFetchAt = 0;
    const unsubscribe = rc.subscribe(topic, () => {
      if (timer !== null) return;
      const wait = Math.max(0, lastFetchAt + PRESENCE_EVENT_REFETCH_MS - Date.now());
      timer = window.setTimeout(() => {
        timer = null;
        lastFetchAt = Date.now();
        void refresh();
      }, wait);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [serverId, refresh]);

  const online = members.filter((m) => m.status === 'online' || m.status === 'in-voice');
  const offline = members.filter((m) => m.status === 'offline');
  const groupedUserIds = new Set<string>();
  const roleGroups = Array.from(
    online.reduce((groups, member) => {
      const role = [...(member.roles ?? [])]
        .filter((item) => item.name !== '@everyone' && item.displaySeparately)
        .sort((a, b) => b.position - a.position)[0];
      if (!role) return groups;
      groupedUserIds.add(member.id);
      const current = groups.get(role.id) ?? { role, members: [] as Member[] };
      current.members.push(member);
      groups.set(role.id, current);
      return groups;
    }, new Map<string, { role: NonNullable<Member['roles']>[number]; members: Member[] }>()).values()
  ).sort((a, b) => b.role.position - a.role.position);
  const ungroupedOnline = online.filter((member) => !groupedUserIds.has(member.id));
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
        {roleGroups.map(({ role, members: roleMembers }) => (
          <MemberSection key={role.id} label={`${role.name} - ${roleMembers.length}`} members={roleMembers} roleColor={role.color} roleIcon={role.icon} currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
        ))}
        <MemberSection label={`Online - ${ungroupedOnline.length}`} members={ungroupedOnline} currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
        <MemberSection label={`Offline - ${offline.length}`} members={offline} dimmed currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
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
            bannerUrl: openMember.bannerUrl ?? null,
            isGuest: openMember.isGuest ?? false,
            roleName: openMember.roleName,
            roleColor: openMember.roleColor,
            statusText: openMember.statusText,
            bio: openMember.bio,
            roles: openMember.roles ?? [],
            onlineStatus: openMember.status === 'in-voice' ? 'in_voice' : openMember.status,
          }}
          getVolume={voice.getRemoteVolume}
          onVolumeChange={voice.setRemoteVolume}
          isBlocked={blockList.isBlocked(openMember.id)}
          onToggleBlock={openMember.id === currentUserId ? undefined : (userId) => void blockList.toggleBlock(userId)}
          onSendMessage={openMember.id === currentUserId ? undefined : (userId) => {
            // Open a DM channel and navigate to the DM view.
            void fetch('/api/dm', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ recipientUserId: userId }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data?.channel?.id) {
                  window.location.assign(`/dm/${data.channel.id}`);
                }
              })
              .catch(() => {});
            setOpenUserId(null);
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
  roleColor,
  roleIcon,
  currentUserId,
  openUserId,
  onOpen,
  onClosePopover,
}: {
  label: string;
  members: Member[];
  dimmed?: boolean;
  roleColor?: string | null;
  roleIcon?: string | null;
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
        {roleIcon ? <span className="material-symbols-outlined text-[14px]" style={{ color: roleColor ?? undefined }} aria-hidden>{roleIcon}</span> : null}
        <span style={{ color: roleColor ?? undefined }}>{label}</span>
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
          <div className="relative size-8 flex-shrink-0">
            <div
              className={member.grayscale ? 'size-8 overflow-hidden rounded-full bg-secondary-container grayscale' : 'size-8 overflow-hidden rounded-full bg-secondary-container'}
              style={roleColor ? { boxShadow: `0 0 0 2px ${roleColor}` } : undefined}
            >
              {member.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
                <img src={member.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-label-sm font-bold text-text-primary">{member.name.charAt(0).toUpperCase()}</span>
              )}
            </div>
            {member.status !== 'offline' ? (
              <span
                className={`absolute -bottom-px -right-px size-3 rounded-full border-2 border-surface-dim ${PRESENCE_DOT_CLASS[member.presence ?? 'online']}`}
                aria-label={PRESENCE_LABELS[member.presence ?? 'online']}
              />
            ) : (
              <span className="absolute -bottom-px -right-px grid size-3 place-items-center rounded-full border-2 border-surface-dim bg-surface-container" aria-label="Offline"><span className="size-1 rounded-full bg-text-muted" /></span>
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
            {member.isGuest ? (
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
