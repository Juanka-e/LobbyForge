'use client';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/client';
import { useFocusTrap } from '@/lib/use-focus-trap';
import type { PresenceStatus } from '@/lib/presence-status';
import { mergeProfileView, type MemberProfileResponse, type ProfileSeed } from '@/lib/member-profile';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  AboutSection,
  BannerIconButton,
  MemberSinceSection,
  MutualServersStrip,
  ProfileAvatar,
  ProfileBanner,
  ProfileNameBlock,
  RolesSection,
  StatusBubble,
  useBannerColor,
} from './profile/ProfileParts';
import { MessageBox, SelfStatusPicker, VolumeControl } from './profile/ProfileControls';
import { ProfileMenu } from './profile/ProfileMenu';
import { ModerationDialog } from './profile/ModerationDialog';
import { useProfileActions } from './profile/useProfileActions';
import { buildProfileMenuItems, EDIT_PROFILE_HREF } from './profile/profileMenuItems';

export type ProfileTab = 'about' | 'mutual';

export interface UserProfilePopoverProps {
  open: boolean;
  onClose: () => void;
  /** What the lobby already knows — the card opens with it at once. */
  user: ProfileSeed | null;
  /** The community the card is opened in (the profile API and its actions are per server). */
  serverId: string;
  serverName?: string;
  /** The profile API's answer; null while it loads (skeletons fill the gaps). */
  profile?: MemberProfileResponse | null;
  loading?: boolean;
  anchorRect?: DOMRect | null;
  /** The element that opened the card — focus goes back to it on close. */
  returnFocusTo?: HTMLElement | null;
  getVolume?: (userId: string) => number;
  onVolumeChange?: (userId: string, volume: number) => void;
  isBlocked?: boolean;
  onToggleBlock?: (userId: string) => void;
  /** Open (or create) the DM and send `text`; resolves to an error to show, or null. */
  onSendMessage?: (userId: string, text: string) => Promise<string | null>;
  onViewFullProfile?: (tab: ProfileTab) => void;
  /** Something changed through the card (roles, timeout): refetch. */
  onProfileChanged?: () => void;
  /** The member left the community (kick, ban). */
  onMemberRemoved?: (userId: string, message: string) => void;
  /** Your own card: the status you picked, and the picker. */
  self?: { status: PresenceStatus; onStatusChange: (status: PresenceStatus) => void } | null;
  /** The member is in the viewer's voice room: server mute is possible there. */
  serverMute?: { channelId: string; muted: boolean } | null;
}

const CARD_WIDTH = 360;
const MARGIN = 12;

/**
 * Where the card goes: beside its anchor (left of it when there is room,
 * else right), level with it and kept on screen; centred on a phone.
 */
export function placeProfileCard(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top'> | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const width = Math.min(size.width, viewport.width - MARGIN * 2);
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN));
  if (!anchor || viewport.width < 640) {
    return {
      left: Math.max(MARGIN, (viewport.width - width) / 2),
      top: anchor ? clampTop(anchor.top - 24) : clampTop((viewport.height - size.height) / 2),
    };
  }
  let left = anchor.left - width - MARGIN;
  if (left < MARGIN) left = Math.min(anchor.right + MARGIN, viewport.width - width - MARGIN);
  return { left: Math.max(MARGIN, left), top: clampTop(anchor.top - 24) };
}

/**
 * The profile card (docs/PROFILES.md) — Discord's popout, in LobbyForge's
 * themed tokens: banner (or a band in the avatar's colour), the avatar
 * with its status, names, the custom status, About me, Member since,
 * Roles, Mutual communities, the volume slider in voice, "Message @name"
 * and "View full profile". The "⋯" menu holds Copy user ID, Block, and the
 * moderation actions the viewer may take. The avatar and the banner open
 * in the image viewer.
 *
 * A non-modal dialog: focus moves in on open, stays inside, and goes back
 * to the opener on close (Escape, the X, or a click elsewhere).
 */
export function UserProfilePopover({
  open,
  onClose,
  user,
  serverId,
  serverName = '',
  profile = null,
  loading = false,
  anchorRect,
  returnFocusTo,
  getVolume,
  onVolumeChange,
  isBlocked = false,
  onToggleBlock,
  onSendMessage,
  onViewFullProfile,
  onProfileChanged,
  onMemberRemoved,
  self = null,
  serverMute = null,
}: UserProfilePopoverProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const sectionId = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [volume, setVolume] = useState(1);
  const [viewer, setViewer] = useState<{ kind: 'avatar' | 'banner'; opener: HTMLElement } | null>(null);
  const visible = open && Boolean(user);
  const userId = user?.userId ?? '';

  const view = user ? mergeProfileView(user, profile, self?.status ?? null) : null;
  const can = profile?.viewerCan ?? null;
  const isSelf = can?.isSelf ?? Boolean(self);
  const bandColor = useBannerColor(view?.avatarUrl, view?.roles);
  const actions = useProfileActions({
    serverId,
    userId,
    name: view?.displayName ?? '',
    data: profile,
    onChanged: onProfileChanged,
    onRemoved: (removed, message) => {
      onMemberRemoved?.(removed, message);
    },
  });

  // Focus the card itself first, so its name is announced; Tab goes on from there.
  useFocusTrap(ref, { active: visible, onEscape: onClose, initialFocus: ref, returnFocusTo, resetKey: userId });

  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null);
      return;
    }
    const place = () => {
      const node = ref.current;
      const height = node?.offsetHeight ?? 0;
      setPosition(
        placeProfileCard(anchorRect ?? null, { width: CARD_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight })
      );
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(place) : null;
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [visible, anchorRect, userId]);

  useEffect(() => {
    if (visible && userId && getVolume) setVolume(getVolume(userId));
  }, [visible, userId, getVolume]);

  // A click anywhere else closes the card — except on another profile
  // anchor (it switches the card) or inside a layer the card opened
  // (image viewer, confirmation).
  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest('[data-user-popover-anchor], [data-profile-layer]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [visible, onClose]);

  if (!visible || !view || typeof document === 'undefined') return null;

  const showVolume = view.inVoice && !isSelf && Boolean(getVolume && onVolumeChange);
  const showMessage = !isSelf && Boolean(onSendMessage) && !isBlocked && (can ? can.message : true);
  const mutualOthers = profile ? profile.profile.mutualServers.filter((server) => server.id !== serverId) : [];
  const timedOutUntil = profile?.profile.timedOutUntil ?? null;
  const menuItems = buildProfileMenuItems({
    t,
    userId,
    name: view.displayName,
    isSelf,
    data: profile,
    isBlocked,
    onCopyId: () => void actions.copyUserId(),
    onToggleBlock: onToggleBlock ? () => onToggleBlock(userId) : undefined,
    onModerate: actions.openDialog,
    serverMute: serverMute
      ? { muted: serverMute.muted, onToggle: () => void actions.setServerMute(serverMute.channelId, !serverMute.muted) }
      : null,
  });

  const openViewer = (kind: 'avatar' | 'banner') => (event: React.MouseEvent<HTMLButtonElement>) =>
    setViewer({ kind, opener: event.currentTarget });

  return createPortal(
    <>
      <div
        ref={ref}
        role="dialog"

        aria-label={t('shell.profile.dialogLabel', { name: view.displayName })}
        data-profile-card
        data-user-id={userId}
        className="lf-pop-in fixed z-[70] max-h-[calc(100dvh-24px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto overflow-x-hidden rounded-xl border border-border-subtle bg-surface-floating shadow-2xl outline-none"
        style={position ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', visibility: 'hidden' }}
      >
        <ProfileBanner name={view.displayName} bannerUrl={view.bannerUrl} color={bandColor} onOpen={openViewer('banner')}>
          <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
            <ProfileMenu label={t('shell.profile.moreActions', { name: view.displayName })} items={menuItems} />
            <BannerIconButton icon="close" label={t('shell.profile.close')} onClick={onClose} />
          </div>
        </ProfileBanner>

        <div className="relative px-4 pb-4">
          <div className="-mt-[46px] flex items-start gap-3">
            <ProfileAvatar
              name={view.displayName}
              avatarUrl={view.avatarUrl}
              presence={view.presence}
              isSelf={isSelf}
              onOpen={openViewer('avatar')}
            />
            {view.statusText ? (
              <div className="mt-[52px] min-w-0 flex-1">
                <StatusBubble text={view.statusText} />
              </div>
            ) : null}
          </div>

          <div className="mt-2">
            <ProfileNameBlock
              titleId={titleId}
              displayName={view.displayName}
              globalDisplayName={view.globalDisplayName}
              nickname={view.nickname}
              isGuest={view.isGuest}
              isOwner={view.isOwner}
              presence={view.presence}
              isSelf={isSelf}
              inVoice={view.inVoice}
            />
          </div>

          {timedOutUntil ? <TimedOutLine until={timedOutUntil} /> : null}

          <div className="mt-3 space-y-3.5 rounded-lg bg-surface-container p-3">
            <AboutSection bio={view.bio} loading={loading && !view.loaded} limited={view.limited} sectionId={sectionId} />
            {view.limited ? null : (
              <MemberSinceSection
                accountCreatedAt={profile?.profile.accountCreatedAt}
                memberSince={profile?.profile.memberSince}
                communityName={serverName}
                loading={!view.loaded && loading}
                sectionId={sectionId}
              />
            )}
            <RolesSection
              roles={view.roles}
              sectionId={sectionId}
              loading={loading && !view.loaded}
              canManage={Boolean(can?.manageRoles)}
              assignableRoles={can?.assignableRoles}
              removableRoleIds={can?.removableRoleIds}
              busy={actions.rolesBusy}
              error={actions.rolesError}
              onAdd={actions.addRole}
              onRemove={actions.removeRole}
            />
            {!isSelf && !view.limited && mutualOthers.length > 0 ? (
              <MutualServersStrip
                servers={profile!.profile.mutualServers}
                count={profile!.profile.mutualServerCount}
                sectionId={sectionId}
                onOpen={onViewFullProfile ? () => onViewFullProfile('mutual') : undefined}
              />
            ) : null}
            {self ? <SelfStatusPicker status={self.status} onChange={self.onStatusChange} sectionId={sectionId} /> : null}
            {showVolume ? (
              <VolumeControl
                name={view.displayName}
                volume={volume}
                onChange={(next) => {
                  setVolume(next);
                  onVolumeChange?.(userId, next);
                }}
              />
            ) : null}
          </div>

          {actions.notice ? (
            <p
              role={actions.notice.tone === 'danger' ? 'alert' : 'status'}
              className={`mt-3 rounded-md px-3 py-2 text-sm ${
                actions.notice.tone === 'danger' ? 'border border-danger/40 bg-danger/10 text-danger' : 'bg-success/15 text-text-primary'
              }`}
            >
              {actions.notice.text}
            </p>
          ) : null}

          {showMessage && onSendMessage ? (
            <MessageBox name={view.displayName} onSend={(text) => onSendMessage(userId, text)} />
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {isSelf ? (
              <Link
                href={EDIT_PROFILE_HREF}
                onClick={onClose}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden>edit</span>
                {t('shell.profile.editProfile')}
              </Link>
            ) : (
              <span />
            )}
            {onViewFullProfile ? (
              <button
                type="button"
                onClick={() => onViewFullProfile('about')}
                className="rounded-md px-1 text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                {t('shell.profile.viewFull')}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <ImageLightbox
        open={viewer !== null}
        src={viewer?.kind === 'banner' ? view.bannerUrl : view.avatarUrl}
        alt={
          viewer?.kind === 'banner'
            ? t('shell.profile.bannerAlt', { name: view.displayName })
            : t('shell.profile.avatarAlt', { name: view.displayName })
        }
        onClose={() => setViewer(null)}
        returnFocusTo={viewer?.opener ?? null}
      />
      {actions.dialog ? (
        <ModerationDialog
          kind={actions.dialog}
          name={view.displayName}
          onCancel={actions.closeDialog}
          onConfirm={actions.moderate}
        />
      ) : null}
    </>,
    document.body
  );
}

/** For moderators: the member is timed out, until when. */
export function TimedOutLine({ until }: { until: string }) {
  const t = useT();
  const when = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(until));
  return (
    <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-2 py-1 text-xs font-medium text-text-primary">
      <span className="material-symbols-outlined text-[14px] text-danger" aria-hidden>timer</span>
      {t('shell.profile.timedOutUntil', { time: when })}
    </p>
  );
}
