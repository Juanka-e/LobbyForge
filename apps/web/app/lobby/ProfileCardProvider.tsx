'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '@/lib/i18n/client';
import { UserProfilePopover, type ProfileTab } from '@/components/modals/UserProfilePopover';
import { FullProfileModal } from '@/components/modals/FullProfileModal';
import {
  fetchMemberProfile,
  invalidateMemberProfile,
  isMemberProfileFresh,
  readCachedMemberProfile,
  type MemberProfileResponse,
  type ProfileRoleView,
  type ProfileSeed,
} from '@/lib/member-profile';
import { userImageUrl } from '@/lib/user-image-url';
import { profileActionErrorMessage } from '@/lib/profile-action-errors';
import type { PresenceStatus } from '@/lib/presence-status';
import { handleEmailUnverified, requestVerificationFocus } from '@/components/email-verification/email-status-store';
import { useLobbyVoice } from './LobbyVoiceProvider';
import { useBlockList } from './BlockListProvider';
import { useLiveMembers } from './LiveMembersProvider';

/**
 * One profile card for the whole lobby (docs/PROFILES.md).
 *
 * Every place that shows a person — the member list, a chat author, the
 * voice roster, the DM header, your own account block — asks this
 * provider to open their card. Only one card is ever open; opening
 * another switches it, opening the same one again closes it. The card
 * opens at once with what the lobby already rendered (the seed) and fills
 * in from the profile API, cached per (server, user) for the session.
 */

/** A member as the lobby page rendered them (already projected for this viewer). */
export interface ProfileMemberSeed {
  id: string;
  name: string;
  globalDisplayName?: string | null;
  nickname?: string | null;
  status?: 'in-voice' | 'online' | 'offline';
  presence?: PresenceStatus;
  isGuest?: boolean;
  username?: string | null;
  avatarUrl?: string | null;
  bannerRef?: string | null;
  statusText?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  accentColor?: string | null;
  roles?: Array<Pick<ProfileRoleView, 'id' | 'name' | 'color' | 'icon' | 'position'>>;
}

export interface OpenProfileInput {
  userId: string;
  /** The element clicked: the card sits beside it and focus returns to it. */
  anchor?: HTMLElement | null;
  /** Fresher facts than the page render (e.g. the member list's live status). */
  seed?: Partial<ProfileSeed>;
}

export interface ProfileCardContextValue {
  openProfile: (input: OpenProfileInput) => void;
  closeProfile: () => void;
  /** Whose card is open, if any. */
  openUserId: string | null;
  /** What the lobby knows about someone (null for strangers and the deleted). */
  seedFor: (userId: string) => ProfileSeed | null;
  /** Members removed through a card (kick, ban) — lists drop them. */
  removedUserIds: ReadonlySet<string>;
  /**
   * Members' roles as the profile API last answered them — fresher than the
   * page render. A role change made in a card shows here as soon as the
   * card re-reads the profile, so the member list regroups at once instead
   * of on the next page load. Without `@everyone`.
   */
  memberRoles: ReadonlyMap<string, ProfileRoleView[]>;
  currentUserId: string | null;
}

const ProfileCardContext = createContext<ProfileCardContextValue | null>(null);

/** The lobby's profile card, or null outside the live lobby (demo mode, tests). */
export function useProfileCard(): ProfileCardContextValue | null {
  return useContext(ProfileCardContext);
}

interface CardState {
  userId: string;
  /** Which opening this is: a card that moves to another opener is a new one (focus returns there). */
  seq: number;
  anchor: HTMLElement | null;
  rect: DOMRect | null;
  seed: Partial<ProfileSeed>;
}

interface FullState {
  userId: string;
  tab: ProfileTab;
  returnTo: HTMLElement | null;
  seed: Partial<ProfileSeed>;
}

const TOAST_MS = 5_000;

/** The same roles, in the same order, shown the same way. */
function sameRoles(a: readonly ProfileRoleView[] | undefined, b: readonly ProfileRoleView[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((role, i) => {
    const other = b[i]!;
    return (
      role.id === other.id &&
      role.name === other.name &&
      role.color === other.color &&
      role.icon === other.icon &&
      role.position === other.position &&
      role.displaySeparately === other.displaySeparately
    );
  });
}

export function ProfileCardProvider({
  serverId,
  serverName,
  currentUserId,
  members: renderedMembers,
  children,
}: {
  serverId: string;
  serverName: string;
  currentUserId: string | null;
  members: ProfileMemberSeed[];
  children: ReactNode;
}) {
  const t = useT();
  const voice = useLobbyVoice();
  const blockList = useBlockList();
  // docs/PROFILES.md "Live updates": the live rows when the lobby has them.
  const live = useLiveMembers();
  const members = live?.members ?? renderedMembers;
  const [card, setCard] = useState<CardState | null>(null);
  const [full, setFull] = useState<FullState | null>(null);
  const [loaded, setLoaded] = useState<{ userId: string; data: MemberProfileResponse | null } | null>(null);
  const [loadingUserId, setLoadingUserId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [removedUserIds, setRemovedUserIds] = useState<ReadonlySet<string>>(() => new Set());
  const [memberRoles, setMemberRoles] = useState<ReadonlyMap<string, ProfileRoleView[]>>(() => new Map());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const openSeq = useRef(0);

  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  /** Keep the roles of a fresh profile answer, for the lists (see `memberRoles`). */
  const noteRoles = useCallback((userId: string, roles: ProfileRoleView[]) => {
    setMemberRoles((current) => (sameRoles(current.get(userId), roles) ? current : new Map(current).set(userId, roles)));
  }, []);
  const participants = voice.participants ?? [];
  const connectedChannelId = voice.activeChannelId ?? null;

  const seedFor = useCallback(
    (userId: string): ProfileSeed | null => {
      const member = membersById.get(userId);
      if (!member) return null;
      return {
        userId,
        displayName: member.name,
        globalDisplayName: member.globalDisplayName ?? null,
        nickname: member.nickname ?? null,
        avatarUrl: member.avatarUrl ?? null,
        // security-review FILE-001: the banner URL is built for the one
        // profile being looked at, never shipped with the list.
        bannerUrl: userImageUrl(userId, 'banner', member.bannerRef),
        isGuest: member.isGuest ?? false,
        username: member.username ?? null,
        statusText: member.statusText ?? null,
        bio: member.bio ?? null,
        pronouns: member.pronouns ?? null,
        accentColor: member.accentColor ?? null,
        roles: memberRoles.get(userId) ?? member.roles ?? [],
        // No presence or voice state from the page render: it goes stale.
        // The member list passes its live ones when it opens a card; any
        // other opener gets the API's.
      };
    },
    [membersById, memberRoles]
  );

  const activeUserId = full?.userId ?? card?.userId ?? null;

  // A live re-read of someone (new roles, name, avatar — or they left)
  // retires what this provider derived from older data: the role overlay
  // and the "removed through a card" mark (they may have come back), and
  // an open card re-reads their profile.
  const liveVersions = live?.versions;
  const seenVersions = useRef<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!liveVersions) return;
    const changed: string[] = [];
    for (const [userId, version] of liveVersions) {
      if (seenVersions.current.get(userId) !== version) changed.push(userId);
    }
    seenVersions.current = liveVersions;
    if (changed.length === 0) return;
    setMemberRoles((current) => {
      if (!changed.some((userId) => current.has(userId))) return current;
      const next = new Map(current);
      for (const userId of changed) next.delete(userId);
      return next;
    });
    setRemovedUserIds((current) => {
      if (!changed.some((userId) => current.has(userId))) return current;
      const next = new Set(current);
      for (const userId of changed) next.delete(userId);
      return next;
    });
    if (activeUserId && changed.includes(activeUserId)) setRefreshTick((tick) => tick + 1);
  }, [liveVersions, activeUserId]);

  // Load (or reuse) the profile of whoever is showing.
  useEffect(() => {
    if (!activeUserId) return;
    // The cache is per viewer (signing in as someone else empties it).
    const cached = readCachedMemberProfile(serverId, activeUserId, currentUserId);
    if (cached) setLoaded({ userId: activeUserId, data: cached });
    // A cached answer shows at once; an old one (or your own, which you may
    // just have edited) is asked for again in the background.
    const revalidate =
      refreshTick > 0 || !cached || activeUserId === currentUserId || !isMemberProfileFresh(serverId, activeUserId);
    if (!revalidate) {
      setLoadingUserId(null);
      return;
    }
    let cancelled = false;
    setLoadingUserId(cached ? null : activeUserId);
    fetchMemberProfile(serverId, activeUserId, { force: Boolean(cached) || refreshTick > 0, viewerId: currentUserId })
      .then((data) => {
        // A fresh answer (after a role change made in the card, too): the
        // member list follows it even if the card has closed meanwhile.
        // Not from the cache above — it may be older than the page render.
        if (data) noteRoles(activeUserId, data.profile.roles);
        if (!cancelled) setLoaded({ userId: activeUserId, data });
      })
      .catch(() => {
        // Keep a cached answer; without one the card keeps what the lobby
        // knew (no endless skeletons). A failure is not cached.
        if (!cancelled && !cached) setLoaded({ userId: activeUserId, data: null });
      })
      .finally(() => {
        if (!cancelled) setLoadingUserId((current) => (current === activeUserId ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, activeUserId, refreshTick, currentUserId, noteRoles]);

  const refresh = useCallback(() => {
    if (activeUserId) invalidateMemberProfile(serverId, activeUserId);
    setRefreshTick((tick) => tick + 1);
  }, [activeUserId, serverId]);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const closeProfile = useCallback(() => {
    setCard(null);
    setRefreshTick(0);
  }, []);

  const openProfile = useCallback(
    ({ userId, anchor = null, seed = {} }: OpenProfileInput) => {
      setFull(null);
      setRefreshTick(0);
      // The same person from the same place again closes the card; from
      // somewhere else (their chat avatar, then their roster entry) it moves.
      setCard((current) =>
        current && current.userId === userId && (current.anchor === anchor || !anchor)
          ? null
          : { userId, seq: ++openSeq.current, anchor, rect: anchor ? anchor.getBoundingClientRect() : null, seed }
      );
    },
    []
  );

  const viewFullProfile = useCallback(
    (tab: ProfileTab) => {
      if (!card) return;
      setFull({ userId: card.userId, tab, returnTo: card.anchor, seed: card.seed });
      setCard(null);
    },
    [card]
  );

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const onMemberRemoved = useCallback(
    (userId: string, message: string) => {
      invalidateMemberProfile(serverId, userId);
      setRemovedUserIds((current) => new Set(current).add(userId));
      setCard(null);
      setFull(null);
      showToast(message);
    },
    [serverId, showToast]
  );

  const sendMessage = useCallback(
    async (userId: string, text: string): Promise<string | null> => {
      const refuse = async (res: Response): Promise<string> => {
        const body = await res.json().catch(() => null);
        // EMAIL.md §4.2: an unverified address may not DM — point at the banner's code field.
        if (handleEmailUnverified(res.status, body)) {
          requestVerificationFocus();
          return t('shell.profile.error.verifyEmail');
        }
        const message = profileActionErrorMessage('message', { status: res.status });
        return t(message.key, message.params);
      };
      try {
        const opened = await fetch('/api/dm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipientUserId: userId }),
        });
        if (!opened.ok) return await refuse(opened);
        const { channel } = (await opened.json()) as { channel?: { id?: string } };
        if (!channel?.id) return t('shell.profile.error.generic', { status: opened.status });
        const sent = await fetch(`/api/dm/${encodeURIComponent(channel.id)}/messages`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!sent.ok) return await refuse(sent);
        const seed = { ...seedFor(userId), ...(card?.userId === userId ? card.seed : full?.seed) };
        const data = loaded?.userId === userId ? loaded.data : null;
        // The conversation opens in the centre column, like one picked from the DM list.
        // Titled with the account's name, like the DM list and a /dm link.
        voice.openDm({
          channelId: channel.id,
          name: data?.profile.globalDisplayName ?? seed.globalDisplayName ?? seed.displayName ?? t('lobbyMain.chat.unknownUser'),
          avatarUrl: data ? data.profile.avatarUrl : (seed.avatarUrl ?? null),
          otherUserId: userId,
        });
        setCard(null);
        setFull(null);
        return null;
      } catch {
        return t('shell.profile.error.network');
      }
    },
    [card, full, loaded, seedFor, t, voice]
  );

  const toggleBlock = useCallback(
    (userId: string) => {
      void blockList.toggleBlock(userId).then((ok) => {
        // A refused or failed (un)block changed nothing — say so.
        if (!ok) {
          showToast(t('shell.profile.error.blockFailed'));
          return;
        }
        invalidateMemberProfile(serverId, userId);
        setRefreshTick((tick) => tick + 1);
      });
    },
    [blockList, serverId, showToast, t]
  );

  const value = useMemo<ProfileCardContextValue>(
    () => ({
      openProfile,
      closeProfile,
      openUserId: card?.userId ?? null,
      seedFor,
      removedUserIds,
      memberRoles,
      currentUserId,
    }),
    [openProfile, closeProfile, card?.userId, seedFor, removedUserIds, memberRoles, currentUserId]
  );

  /** The seed for a card or the full profile: the page render, the opener's fresher facts, live voice. */
  const seedOf = (userId: string, override: Partial<ProfileSeed>): ProfileSeed => {
    const base = seedFor(userId) ?? { userId, displayName: override.displayName ?? t('lobbyMain.chat.unknownUser') };
    const inRoom = participants.some((p) => p.identity === userId);
    return {
      ...base,
      ...override,
      userId,
      displayName: override.displayName ?? base.displayName,
      // In the viewer's own voice room: known live. Otherwise only what the
      // opener knows live; without it the API decides.
      inVoice: inRoom ? true : override.inVoice,
    };
  };

  const selfProps = (userId: string) =>
    currentUserId && userId === currentUserId
      ? { status: voice.presenceStatus ?? 'online', onStatusChange: voice.setPresenceStatus }
      : null;

  /** Server mute is offered for someone in the viewer's own voice room (the route needs that room). */
  const serverMuteFor = (userId: string) => {
    if (!connectedChannelId || userId === currentUserId) return null;
    const participant = participants.find((p) => p.identity === userId && !p.isLocal);
    return participant ? { channelId: connectedChannelId, muted: Boolean(participant.serverMuted) } : null;
  };

  const dataFor = (userId: string) => (loaded?.userId === userId ? loaded.data : null);
  const isLoading = (userId: string) =>
    loadingUserId === userId || (loaded?.userId !== userId && !readCachedMemberProfile(serverId, userId, currentUserId));

  return (
    <ProfileCardContext.Provider value={value}>
      {children}
      {card ? (
        <UserProfilePopover
          key={`${card.userId}:${card.seq}`}
          open
          onClose={closeProfile}
          user={seedOf(card.userId, card.seed)}
          serverId={serverId}
          serverName={serverName}
          viewerId={currentUserId}
          profile={dataFor(card.userId)}
          loading={isLoading(card.userId)}
          anchorRect={card.rect}
          returnFocusTo={card.anchor}
          getVolume={voice.getRemoteVolume}
          onVolumeChange={voice.setRemoteVolume}
          isBlocked={blockList.isBlocked(card.userId)}
          onToggleBlock={card.userId === currentUserId ? undefined : toggleBlock}
          onSendMessage={card.userId === currentUserId ? undefined : sendMessage}
          onViewFullProfile={viewFullProfile}
          onProfileChanged={refresh}
          onMemberRemoved={onMemberRemoved}
          self={selfProps(card.userId)}
          serverMute={serverMuteFor(card.userId)}
        />
      ) : null}
      {full ? (
        <FullProfileModal
          key={`${full.userId}:${full.tab}`}
          open
          onClose={() => setFull(null)}
          user={seedOf(full.userId, full.seed)}
          serverId={serverId}
          serverName={serverName}
          viewerId={currentUserId}
          profile={dataFor(full.userId)}
          loading={isLoading(full.userId)}
          initialTab={full.tab}
          returnFocusTo={full.returnTo}
          isBlocked={blockList.isBlocked(full.userId)}
          onToggleBlock={full.userId === currentUserId ? undefined : toggleBlock}
          onSendMessage={full.userId === currentUserId ? undefined : sendMessage}
          onProfileChanged={refresh}
          onMemberRemoved={onMemberRemoved}
          self={selfProps(full.userId)}
          serverMute={serverMuteFor(full.userId)}
        />
      ) : null}
      {toast ? (
        <div
          role="status"
          className="lf-pop-in fixed bottom-4 left-1/2 z-[85] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-border-subtle bg-surface-floating px-4 py-2.5 text-sm text-text-primary shadow-xl"
        >
          {toast}
        </div>
      ) : null}
    </ProfileCardContext.Provider>
  );
}

/**
 * A person shown somewhere in the lobby, made clickable: it opens their
 * profile card. Outside the live lobby (no provider) it renders the same
 * content without the button.
 */
export function ProfileTrigger({
  userId,
  seed,
  className,
  label,
  children,
  decorative = false,
  testId,
  markers,
}: {
  userId: string | null | undefined;
  seed?: Partial<ProfileSeed>;
  className?: string;
  /** Accessible name when the content alone does not say whose profile it is. */
  label?: string;
  children: ReactNode;
  /**
   * A second way to the same card next to a labelled one (a chat avatar
   * beside the author's name): clickable, but out of the tab order and
   * hidden from assistive technology so it is not announced twice.
   */
  decorative?: boolean;
  testId?: string;
  /** Data attributes the surrounding styles key on (e.g. `data-chat-avatar`). */
  markers?: Record<`data-${string}`, string | boolean>;
}) {
  const profile = useProfileCard();
  if (!profile || !userId) {
    return (
      <span className={className} data-testid={testId} {...markers}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...markers}
      data-user-popover-anchor
      data-testid={testId}
      aria-haspopup="dialog"
      aria-expanded={decorative ? undefined : profile.openUserId === userId}
      aria-label={label}
      aria-hidden={decorative || undefined}
      tabIndex={decorative ? -1 : undefined}
      onClick={(event) => {
        event.stopPropagation();
        profile.openProfile({ userId, anchor: event.currentTarget, seed });
      }}
      className={className}
    >
      {children}
    </button>
  );
}
