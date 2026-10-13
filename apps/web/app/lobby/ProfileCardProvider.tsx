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
  avatarUrl?: string | null;
  bannerRef?: string | null;
  statusText?: string | null;
  bio?: string | null;
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
  currentUserId: string | null;
}

const ProfileCardContext = createContext<ProfileCardContextValue | null>(null);

/** The lobby's profile card, or null outside the live lobby (demo mode, tests). */
export function useProfileCard(): ProfileCardContextValue | null {
  return useContext(ProfileCardContext);
}

interface CardState {
  userId: string;
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

export function ProfileCardProvider({
  serverId,
  serverName,
  currentUserId,
  members,
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
  const [card, setCard] = useState<CardState | null>(null);
  const [full, setFull] = useState<FullState | null>(null);
  const [loaded, setLoaded] = useState<{ userId: string; data: MemberProfileResponse | null } | null>(null);
  const [loadingUserId, setLoadingUserId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [removedUserIds, setRemovedUserIds] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
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
        statusText: member.statusText ?? null,
        bio: member.bio ?? null,
        roles: member.roles ?? [],
        presence: member.status === 'offline' ? 'offline' : (member.presence ?? null),
        inVoice: member.status === 'in-voice',
      };
    },
    [membersById]
  );

  const activeUserId = full?.userId ?? card?.userId ?? null;

  // Load (or reuse) the profile of whoever is showing.
  useEffect(() => {
    if (!activeUserId) return;
    const cached = refreshTick === 0 ? readCachedMemberProfile(serverId, activeUserId) : null;
    if (cached) {
      setLoaded({ userId: activeUserId, data: cached });
      return;
    }
    let cancelled = false;
    setLoadingUserId(activeUserId);
    fetchMemberProfile(serverId, activeUserId, { force: refreshTick > 0 })
      .then((data) => {
        if (!cancelled) setLoaded({ userId: activeUserId, data });
      })
      .catch(() => {
        // The card keeps what the lobby knew (no endless skeletons); the
        // next opening retries — a failure is not cached.
        if (!cancelled) setLoaded({ userId: activeUserId, data: null });
      })
      .finally(() => {
        if (!cancelled) setLoadingUserId((current) => (current === activeUserId ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, activeUserId, refreshTick]);

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
      setCard((current) =>
        current && current.userId === userId
          ? null
          : { userId, anchor, rect: anchor ? anchor.getBoundingClientRect() : null, seed }
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
        voice.openDm({
          channelId: channel.id,
          name: data?.profile.displayName ?? seed.displayName ?? t('lobbyMain.chat.unknownUser'),
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
      void blockList.toggleBlock(userId).then(() => {
        invalidateMemberProfile(serverId, userId);
        setRefreshTick((tick) => tick + 1);
      });
    },
    [blockList, serverId]
  );

  const value = useMemo<ProfileCardContextValue>(
    () => ({
      openProfile,
      closeProfile,
      openUserId: card?.userId ?? null,
      seedFor,
      removedUserIds,
      currentUserId,
    }),
    [openProfile, closeProfile, card?.userId, seedFor, removedUserIds, currentUserId]
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
      inVoice: Boolean(override.inVoice ?? base.inVoice) || inRoom,
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
  const isLoading = (userId: string) => loadingUserId === userId || (loaded?.userId !== userId && !readCachedMemberProfile(serverId, userId));

  return (
    <ProfileCardContext.Provider value={value}>
      {children}
      {card ? (
        <UserProfilePopover
          key={card.userId}
          open
          onClose={closeProfile}
          user={seedOf(card.userId, card.seed)}
          serverId={serverId}
          serverName={serverName}
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
