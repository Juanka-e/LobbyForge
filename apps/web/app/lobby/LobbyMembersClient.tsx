'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getRealtimeClient } from '@/lib/realtime-client';
import { UserProfilePopover } from '@/components/modals/UserProfilePopover';
import { MemberBlockButton } from './MemberBlockButton';
import { BotAvatar, BotBadge, BotProfilePopover, type LobbyBot } from './BotIdentity';
import { useLobbyVoice } from './LobbyVoiceProvider';
import { useBlockList } from './BlockListProvider';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { userImageUrl } from '@/lib/user-image-url';
import { handleEmailUnverified, requestVerificationFocus } from '@/components/email-verification/email-status-store';
import {
  PRESENCE_DOT_CLASS,
  PRESENCE_LABEL_KEYS,
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
  /** Short image URL from the server (security-review FILE-001) — never a data URL. */
  avatarUrl?: string | null;
  /** Banner reference; turned into a URL only when the popover opens. */
  bannerRef?: string | null;
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
  bots = [],
  canManageServer = false,
}: {
  serverId: string;
  initialMembers: Member[];
  voiceChannelIds: string[];
  currentUserId: string | null;
  /** The server's enabled bots — their own group, always with the BOT badge. */
  bots?: LobbyBot[];
  canManageServer?: boolean;
}) {
  const t = useT();
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const voice = useLobbyVoice();
  const blockList = useBlockList();
  const voiceChannelIdsRef = useRef(new Set(voiceChannelIds));
  voiceChannelIdsRef.current = new Set(voiceChannelIds);

  // Shared popover state — only one popover can be open at a time.
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [openBotId, setOpenBotId] = useState<string | null>(null);
  const closeBotPopover = useCallback(() => setOpenBotId(null), []);

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
    setOpenBotId(null);
    setOpenUserId(m.id);
  }

  function toggleBotPopover(bot: LobbyBot, rect: DOMRect) {
    setOpenUserId(null);
    setAnchorRect(rect);
    setOpenBotId((current) => (current === bot.id ? null : bot.id));
  }
  const openBot = bots.find((b) => b.id === openBotId);

  return (
    <>
      <aside className="w-[200px] lg:w-[230px] flex-shrink-0 bg-surface-dim border-l border-border-subtle hidden lg:flex flex-col h-full z-20 overflow-y-auto p-4 animate-fade-in-left">
        {members.length === 0 ? (
          <p className="font-label-xs text-text-muted italic">{t('lobby.roster.empty')}</p>
        ) : null}
        {roleGroups.map(({ role, members: roleMembers }) => (
          <MemberSection key={role.id} label={`${role.name} - ${roleMembers.length}`} members={roleMembers} roleColor={role.color} roleIcon={role.icon} currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
        ))}
        <MemberSection label={t('lobby.roster.onlineGroup', { count: ungroupedOnline.length })} members={ungroupedOnline} currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
        <BotSection bots={bots} openBotId={openBotId} onToggle={toggleBotPopover} />
        <MemberSection label={t('lobby.roster.offlineGroup', { count: offline.length })} members={offline} dimmed currentUserId={currentUserId} openUserId={openUserId} onOpen={openPopover} onClosePopover={() => setOpenUserId(null)} />
      </aside>
      {openBot ? (
        <BotProfilePopover bot={openBot} anchorRect={anchorRect} onClose={closeBotPopover} canManage={canManageServer} />
      ) : null}
      {openMember ? (
        <UserProfilePopover
          open={true}
          onClose={() => setOpenUserId(null)}
          anchorRect={anchorRect}
          user={{
            userId: openMember.id,
            displayName: openMember.name,
            avatarUrl: openMember.avatarUrl ?? null,
            // security-review FILE-001: the banner is fetched only now, for
            // the one profile being looked at — never part of the list.
            bannerUrl: userImageUrl(openMember.id, 'banner', openMember.bannerRef),
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
              .then(async (r) => {
                if (r.ok) return r.json();
                // EMAIL.md §4.2: refused for an unverified email — lock
                // and point at the banner's code field, not a silent no-op.
                if (handleEmailUnverified(r.status, await r.json().catch(() => null))) requestVerificationFocus();
                return null;
              })
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

/** The server's bots: robot avatar, name and the BOT badge; click for the bot profile. */
function BotSection({
  bots,
  openBotId,
  onToggle,
}: {
  bots: LobbyBot[];
  openBotId: string | null;
  onToggle: (bot: LobbyBot, rect: DOMRect) => void;
}) {
  const t = useT();
  if (bots.length === 0) return null;
  return (
    <div className="mb-6" data-testid="members-bots">
      <h3 className="font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 text-text-secondary">
        <span>{t('lobbyMain.bots.group', { count: bots.length })}</span>
        <div className="h-[1px] flex-1 bg-border-subtle" />
      </h3>
      <ul className="space-y-1">
        {bots.map((bot) => (
          <li key={bot.id}>
            <button
              type="button"
              data-user-popover-anchor
              aria-expanded={openBotId === bot.id}
              onClick={(event) => {
                event.stopPropagation();
                onToggle(bot, event.currentTarget.getBoundingClientRect());
              }}
              className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-container/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <BotAvatar size="sm" />
              <span className="min-w-0 flex-1 truncate font-label-sm text-text-secondary">{bot.name}</span>
              <BotBadge />
            </button>
          </li>
        ))}
      </ul>
    </div>
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
  // Offline rows are dimmed by their avatar and status dot only: an
  // opacity on the list or the row took the text with it, down to 3.2:1.
  // Text keeps a themed token that clears 4.5:1 on this panel in every
  // theme (text-secondary; text-muted is only 4.05:1 on the light theme).
  return (
    <div className="mb-6">
      <h3 className="font-label-xs uppercase tracking-wider mb-2 flex items-center gap-2 text-text-secondary">
        {roleIcon ? <span className="material-symbols-outlined text-[14px]" style={{ color: roleColor ?? undefined }} aria-hidden>{roleIcon}</span> : null}
        <span style={{ color: roleColor ?? undefined }}>{label}</span>
        <div className="h-[1px] flex-1 bg-border-subtle" />
      </h3>
      <ul className="space-y-1">
        {members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            dimmed={dimmed}
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
  dimmed,
  currentUserId,
  isOpen,
  onOpen,
  onClose,
}: {
  member: Member;
  /** In the offline group: fade the avatar and status dot, never the text. */
  dimmed?: boolean;
  currentUserId: string | null;
  isOpen: boolean;
  onOpen: (rect: DOMRect) => void;
  onClose: () => void;
}) {
  const t = useT();
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
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-container/50 group">
        <button
          type="button"
          data-user-popover-anchor
          onClick={handleClick}
          className="min-w-0 flex flex-1 items-center gap-3 text-left"
        >
          <div className={dimmed ? 'relative size-8 flex-shrink-0 opacity-50' : 'relative size-8 flex-shrink-0'} data-member-avatar>
            <div
              className={member.grayscale ? 'size-8 overflow-hidden rounded-full bg-secondary-container grayscale' : 'size-8 overflow-hidden rounded-full bg-secondary-container'}
              style={roleColor ? { boxShadow: `0 0 0 2px ${roleColor}` } : undefined}
            >
              {member.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
                <img src={member.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-label-sm font-bold text-text-primary">{initialOf(member.name, { locale: t.locale })}</span>
              )}
            </div>
            {member.status !== 'offline' ? (
              <span
                className={`absolute -bottom-px -right-px size-3 rounded-full border-2 border-surface-dim ${PRESENCE_DOT_CLASS[member.presence ?? 'online']}`}
                aria-label={t(PRESENCE_LABEL_KEYS[member.presence ?? 'online'])}
              />
            ) : (
              <span className="absolute -bottom-px -right-px grid size-3 place-items-center rounded-full border-2 border-surface-dim bg-surface-container" aria-label={t('lobby.roster.offlineStatus')}><span className="size-1 rounded-full bg-text-muted" /></span>
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
              <span className="text-[10px] text-text-secondary font-medium truncate">{t('lobby.roster.guest')}</span>
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
