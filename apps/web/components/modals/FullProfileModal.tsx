'use client';

import Link from 'next/link';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/client';
import { useFocusTrap } from '@/lib/use-focus-trap';
import type { PresenceStatus } from '@/lib/presence-status';
import { mergeProfileView, type MemberProfileResponse, type ProfileSeed } from '@/lib/member-profile';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  AboutSection,
  BannerIconButton,
  LimitedNotice,
  MemberSinceSection,
  MutualServersList,
  ProfileAvatar,
  ProfileBanner,
  ProfileNameBlock,
  RolesSection,
  StatusBubble,
  useBannerColor,
} from './profile/ProfileParts';
import { MessageBox } from './profile/ProfileControls';
import { ProfileMenu } from './profile/ProfileMenu';
import { ModerationDialog } from './profile/ModerationDialog';
import { useProfileActions } from './profile/useProfileActions';
import { buildProfileMenuItems, EDIT_PROFILE_HREF } from './profile/profileMenuItems';
import { TimedOutLine, type ProfileTab } from './UserProfilePopover';

export interface FullProfileModalProps {
  open: boolean;
  onClose: () => void;
  user: ProfileSeed | null;
  serverId: string;
  serverName?: string;
  profile?: MemberProfileResponse | null;
  loading?: boolean;
  initialTab?: ProfileTab;
  /** Focus goes back here on close (the element the profile was opened from). */
  returnFocusTo?: HTMLElement | null;
  isBlocked?: boolean;
  onToggleBlock?: (userId: string) => void;
  onSendMessage?: (userId: string, text: string) => Promise<string | null>;
  onProfileChanged?: () => void;
  onMemberRemoved?: (userId: string, message: string) => void;
  self?: { status: PresenceStatus } | null;
  serverMute?: { channelId: string; muted: boolean } | null;
}

const TABS: ProfileTab[] = ['about', 'mutual'];

/**
 * The full profile (docs/PROFILES.md): a larger banner and avatar, names
 * and status, and two tabs — About (bio, member since, roles) and Mutual
 * communities (each a link to that community's lobby). The same actions
 * as the card: the "⋯" menu and, with Manage Roles, adding and removing
 * roles. A modal: focus stays inside; Escape, the X or the backdrop close.
 */
export function FullProfileModal({
  open,
  onClose,
  user,
  serverId,
  serverName = '',
  profile = null,
  loading = false,
  initialTab = 'about',
  returnFocusTo,
  isBlocked = false,
  onToggleBlock,
  onSendMessage,
  onProfileChanged,
  onMemberRemoved,
  self = null,
  serverMute = null,
}: FullProfileModalProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const sectionId = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const tabRefs = useRef<Record<ProfileTab, HTMLButtonElement | null>>({ about: null, mutual: null });
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
    onRemoved: (removed, message) => onMemberRemoved?.(removed, message),
  });
  useFocusTrap(panelRef, { active: visible, onEscape: onClose, initialFocus: panelRef, returnFocusTo, resetKey: userId });

  if (!visible || !view || typeof document === 'undefined') return null;

  const mutualCount = profile?.profile.mutualServerCount ?? 0;
  const showMessage = !isSelf && Boolean(onSendMessage) && !isBlocked && (can ? can.message : true);
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

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const next =
      event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length]
      : event.key === 'ArrowLeft' ? TABS[(index - 1 + TABS.length) % TABS.length]
      : event.key === 'Home' ? TABS[0]
      : event.key === 'End' ? TABS[TABS.length - 1]
      : null;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const tabLabel = (id: ProfileTab) =>
    id === 'about' ? t('shell.profile.tab.about') : t('shell.profile.mutualCount', { count: mutualCount });

  return createPortal(
    <>
      <div className="fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6" data-profile-layer>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden onMouseDown={onClose} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('shell.profile.dialogLabel', { name: view.displayName })}
          data-full-profile
          className="lf-pop-in relative flex max-h-[min(90dvh,760px)] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-floating shadow-2xl outline-none"
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProfileBanner
              name={view.displayName}
              bannerUrl={view.bannerUrl}
              color={bandColor}
              onOpen={openViewer('banner')}
              heightClass="h-[150px] sm:h-[190px]"
            >
              <div className="absolute right-3 top-3 flex items-center gap-1.5">
                <ProfileMenu label={t('shell.profile.moreActions', { name: view.displayName })} items={menuItems} />
                <BannerIconButton icon="close" label={t('shell.profile.close')} onClick={onClose} />
              </div>
            </ProfileBanner>

            <div className="px-5 pb-5 sm:px-6">
              <div className="-mt-[60px] flex flex-wrap items-end justify-between gap-3">
                <ProfileAvatar
                  name={view.displayName}
                  avatarUrl={view.avatarUrl}
                  presence={view.presence}
                  isSelf={isSelf}
                  sizeClass="size-[120px]"
                  textClass="text-4xl"
                  onOpen={openViewer('avatar')}
                />
                {isSelf ? (
                  <Link
                    href={EDIT_PROFILE_HREF}
                    onClick={onClose}
                    className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden>edit</span>
                    {t('shell.profile.editProfile')}
                  </Link>
                ) : null}
              </div>

              <div className="mt-3">
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
              {view.statusText ? (
                <div className="mt-3 max-w-md">
                  <StatusBubble text={view.statusText} />
                </div>
              ) : null}
              {profile?.profile.timedOutUntil ? <TimedOutLine until={profile.profile.timedOutUntil} /> : null}

              {showMessage && onSendMessage ? (
                <MessageBox name={view.displayName} onSend={(text) => onSendMessage(userId, text)} />
              ) : null}

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

              <div role="tablist" aria-label={t('shell.profile.tabsLabel')} className="mt-5 flex gap-4 border-b border-border-subtle">
                {TABS.map((id) => (
                  <button
                    key={id}
                    ref={(node) => {
                      tabRefs.current[id] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`${tabsId}-tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`${tabsId}-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    onKeyDown={onTabKey}
                    className={`-mb-px border-b-2 px-0.5 pb-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                      tab === id ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {tabLabel(id)}
                  </button>
                ))}
              </div>

              <div
                role="tabpanel"
                id={`${tabsId}-panel-${tab}`}
                aria-labelledby={`${tabsId}-tab-${tab}`}
                className="pt-4"
              >
                {tab === 'about' ? (
                  <div className="space-y-5">
                    <AboutSection bio={view.bio} loading={loading && !view.loaded} limited={view.limited} sectionId={sectionId} />
                    {view.limited ? null : (
                      <>
                        <MemberSinceSection
                          accountCreatedAt={profile?.profile.accountCreatedAt}
                          memberSince={profile?.profile.memberSince}
                          communityName={serverName}
                          loading={!view.loaded && loading}
                          sectionId={sectionId}
                        />
                      </>
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
                  </div>
                ) : view.limited ? (
                  <LimitedNotice />
                ) : (
                  <MutualServersList
                    servers={profile?.profile.mutualServers ?? []}
                    count={mutualCount}
                    currentServerId={serverId}
                    loading={loading && !view.loaded}
                  />
                )}
              </div>
            </div>
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
        <ModerationDialog kind={actions.dialog} name={view.displayName} onCancel={actions.closeDialog} onConfirm={actions.moderate} />
      ) : null}
    </>,
    document.body
  );
}
