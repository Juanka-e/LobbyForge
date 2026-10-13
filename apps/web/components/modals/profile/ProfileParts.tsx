'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';
import { PRESENCE_DOT_CLASS, type PresenceStatus } from '@/lib/presence-status';
import { bannerBandColor, sampleAvatarColor } from '@/lib/profile-accent';
import type { MutualServerView, ProfileRoleView } from '@/lib/member-profile';

/**
 * The pieces the profile card and the full profile share
 * (docs/PROFILES.md). Presentational: data and actions come in as props.
 * Themed tokens only — the banner band's colour is the one inline style,
 * and it falls back to the theme accent variable.
 */

/**
 * The words for a member's status on a profile. "Offline" for someone
 * else — the status they CHOSE was "Invisible", which only they see; Do Not
 * Disturb has its own words (the old card had no entry for it at all).
 */
export function presenceLabelKey(presence: PresenceStatus, isSelf = false): string {
  switch (presence) {
    case 'online':
      return 'shell.profile.status.online';
    case 'idle':
      return 'shell.profile.status.idle';
    case 'dnd':
      return 'shell.profile.status.dnd';
    case 'offline':
    default:
      return isSelf ? 'shell.profile.status.invisible' : 'shell.profile.status.offline';
  }
}

/** The banner band's colour for this member (sampled avatar → role colour → accent). */
export function useBannerColor(avatarUrl: string | null | undefined, roles: ReadonlyArray<{ color: string | null }> | undefined): string {
  const [sampled, setSampled] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSampled(null);
    void sampleAvatarColor(avatarUrl).then((color) => {
      if (!cancelled) setSampled(color);
    });
    return () => {
      cancelled = true;
    };
  }, [avatarUrl]);
  return bannerBandColor(sampled, roles);
}

/** A grey bar while a part of the profile is still loading. */
export function Skeleton({ className = 'h-3 w-24' }: { className?: string }) {
  return <span className={`block rounded bg-surface-container-high motion-safe:animate-pulse ${className}`} aria-hidden />;
}

export function ProfileBanner({
  name,
  bannerUrl,
  color,
  onOpen,
  heightClass = 'h-[120px]',
  children,
}: {
  name: string;
  bannerUrl: string | null;
  color: string;
  /** Open the banner in the image viewer (only with a banner). */
  onOpen?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  heightClass?: string;
  /** Controls drawn on top of the banner (close, ⋯). */
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className={`relative ${heightClass} w-full overflow-hidden`} data-profile-banner>
      {bannerUrl ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('shell.profile.viewBanner', { name })}
          className="block size-full bg-surface-container-high bg-cover bg-center transition-[filter] hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary"
          style={{ backgroundImage: `url(${bannerUrl})` }}
        />
      ) : (
        <div className="size-full" style={{ backgroundColor: color }} aria-hidden data-banner-band />
      )}
      {children}
    </div>
  );
}

/** Round icon buttons drawn over the banner. Dark scrim + white glyph: they sit on an image or a colour, not on the theme. */
export function BannerIconButton({
  icon,
  label,
  onClick,
  buttonRef,
  expanded,
  hasPopup,
}: {
  icon: string;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
  hasPopup?: 'menu';
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      className="grid size-8 place-items-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden>{icon}</span>
    </button>
  );
}

export function ProfileAvatar({
  name,
  avatarUrl,
  presence,
  sizeClass = 'size-[92px]',
  textClass = 'text-3xl',
  onOpen,
  isSelf = false,
}: {
  name: string;
  avatarUrl: string | null;
  /** The dot on the avatar; none when the status is not shown at all. */
  presence: PresenceStatus | null;
  sizeClass?: string;
  textClass?: string;
  /** Open the photo in the image viewer (only with a photo). */
  onOpen?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Your own profile: an "offline" status is the Invisible you picked. */
  isSelf?: boolean;
}) {
  const t = useT();
  const presenceLabel = presence ? t(presenceLabelKey(presence, isSelf)) : '';
  const face = avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- user avatars come from the same-origin image route
    <img src={avatarUrl} alt="" className="size-full object-cover" draggable={false} />
  ) : (
    <span className={`grid size-full place-items-center font-semibold text-text-primary ${textClass}`} aria-hidden>
      {initialOf(name, { locale: t.locale })}
    </span>
  );
  return (
    <div className={`relative ${sizeClass} flex-none`}>
      {avatarUrl && onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('shell.profile.viewAvatar', { name })}
          className="block size-full overflow-hidden rounded-full border-[6px] border-surface-floating bg-surface-container transition-[filter] hover:brightness-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          data-profile-avatar
        >
          {face}
        </button>
      ) : (
        <div className="size-full overflow-hidden rounded-full border-[6px] border-surface-floating bg-surface-container" data-profile-avatar>
          {face}
        </div>
      )}
      {presence ? (
        <span
          role="img"
          aria-label={presenceLabel}
          title={presenceLabel}
          className={`absolute bottom-1 right-1 size-[24px] rounded-full border-[5px] border-surface-floating ${PRESENCE_DOT_CLASS[presence]}`}
          data-presence={presence}
        />
      ) : null}
    </div>
  );
}

/** Small uppercase heading of a profile section. */
export function SectionHeading({ id, children, action }: { id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
      <h3 id={id} className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">
        {children}
      </h3>
      {action}
    </div>
  );
}

export function ProfileNameBlock({
  displayName,
  globalDisplayName,
  nickname,
  isGuest,
  isOwner,
  presence,
  inVoice,
  isSelf = false,
  titleId,
}: {
  displayName: string;
  globalDisplayName?: string | null;
  nickname?: string | null;
  isGuest: boolean;
  isOwner?: boolean;
  presence: PresenceStatus | null;
  inVoice?: boolean;
  /** Your own profile: an "offline" status is the Invisible you picked. */
  isSelf?: boolean;
  titleId: string;
}) {
  const t = useT();
  // Discord's order: the name this community sees, then the account's own
  // name under it when a nickname replaces it here.
  const showGlobal = Boolean(nickname && globalDisplayName && globalDisplayName !== displayName);
  return (
    <div className="min-w-0">
      <h2 id={titleId} className="flex min-w-0 items-center gap-1.5 text-xl font-bold leading-tight text-text-primary">
        <span className="break-words [overflow-wrap:anywhere]">{displayName}</span>
        {isOwner ? (
          <span
            className="material-symbols-outlined flex-none text-[18px] text-ember"
            role="img"
            aria-label={t('shell.profile.owner')}
            title={t('shell.profile.owner')}
          >
            crown
          </span>
        ) : null}
      </h2>
      {showGlobal ? (
        <p className="mt-0.5 truncate text-sm text-text-secondary" title={t('shell.profile.globalNameTitle')}>
          {globalDisplayName}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {presence ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-2 py-0.5 font-medium text-text-secondary">
            <span className={`size-2 rounded-full ${PRESENCE_DOT_CLASS[presence]}`} aria-hidden />
            {t(presenceLabelKey(presence, isSelf))}
          </span>
        ) : null}
        {inVoice ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-medium text-text-primary">
            <span className="material-symbols-outlined text-[14px] text-success" aria-hidden>headset_mic</span>
            {t('shell.profile.status.inVoice')}
          </span>
        ) : null}
        {isGuest ? (
          <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 font-semibold uppercase tracking-wide text-text-secondary">
            {t('common.guest')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The custom status, as a speech bubble (Discord's place for it). */
export function StatusBubble({ text }: { text: string }) {
  const t = useT();
  return (
    <p
      className="relative line-clamp-2 break-words rounded-2xl rounded-tl-sm bg-surface-container px-3 py-1.5 text-sm leading-5 text-text-secondary"
      title={text}
      aria-label={t('shell.profile.customStatus', { status: text })}
    >
      {text}
    </p>
  );
}

export function AboutSection({ bio, loading, sectionId }: { bio: string | null | undefined; loading?: boolean; sectionId: string }) {
  const t = useT();
  const headingId = `${sectionId}-about`;
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId}>{t('shell.profile.about')}</SectionHeading>
      {loading && !bio ? (
        <div className="space-y-1.5 py-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : (
        <p
          data-testid="profile-about-body"
          className={`whitespace-pre-wrap break-words text-sm leading-5 ${bio ? 'text-text-primary' : 'italic text-text-secondary'}`}
        >
          {bio || t('shell.profile.noBio')}
        </p>
      )}
    </section>
  );
}

/** "Member since": the LobbyForge account and this community, in the viewer's locale. */
export function MemberSinceSection({
  accountCreatedAt,
  memberSince,
  communityName,
  loading,
  sectionId,
}: {
  accountCreatedAt: string | null | undefined;
  memberSince: string | null | undefined;
  communityName: string;
  loading?: boolean;
  sectionId: string;
}) {
  const t = useT();
  const format = useMemo(
    () => new Intl.DateTimeFormat(t.locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [t.locale]
  );
  const headingId = `${sectionId}-since`;
  if (!loading && !accountCreatedAt && !memberSince) return null;
  const date = (iso: string | null | undefined) => (iso ? format.format(new Date(iso)) : null);
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId}>{t('shell.profile.memberSince')}</SectionHeading>
      {loading ? (
        <div className="flex gap-4 py-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : (
        <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-text-primary">
          {accountCreatedAt ? (
            <div className="flex items-center gap-1.5" title={t('shell.profile.sinceLobbyForge')}>
              <dt className="grid size-5 place-items-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                <span aria-hidden>LF</span>
                <span className="sr-only">{t('shell.profile.sinceLobbyForge')}</span>
              </dt>
              <dd>{date(accountCreatedAt)}</dd>
            </div>
          ) : null}
          {accountCreatedAt && memberSince ? <span className="size-1 rounded-full bg-text-muted" aria-hidden /> : null}
          {memberSince ? (
            <div className="flex items-center gap-1.5" title={t('shell.profile.sinceCommunity', { name: communityName })}>
              <dt className="grid size-5 place-items-center rounded-full bg-surface-container-high text-[10px] font-bold text-text-primary">
                <span aria-hidden>{initialOf(communityName, { locale: t.locale })}</span>
                <span className="sr-only">{t('shell.profile.sinceCommunity', { name: communityName })}</span>
              </dt>
              <dd>{date(memberSince)}</dd>
            </div>
          ) : null}
        </dl>
      )}
    </section>
  );
}

/** A role's colour dot (or its icon), never colour alone: the name is always next to it. */
export function RoleDot({ role }: { role: Pick<ProfileRoleView, 'color' | 'icon'> }) {
  return role.icon ? (
    <span className="material-symbols-outlined text-[14px] text-text-secondary" style={{ color: role.color ?? undefined }} aria-hidden>
      {role.icon}
    </span>
  ) : (
    <span
      className={`size-2.5 flex-none rounded-full ${role.color ? '' : 'bg-text-muted'}`}
      style={role.color ? { backgroundColor: role.color } : undefined}
      aria-hidden
    />
  );
}

export function RolesSection({
  roles,
  sectionId,
  loading,
  removableRoleIds = [],
  assignableRoles = [],
  canManage = false,
  busy = false,
  error,
  onAdd,
  onRemove,
}: {
  roles: ProfileRoleView[];
  sectionId: string;
  loading?: boolean;
  removableRoleIds?: string[];
  assignableRoles?: ProfileRoleView[];
  canManage?: boolean;
  busy?: boolean;
  error?: string | null;
  onAdd?: (roleId: string) => void;
  onRemove?: (roleId: string) => void;
}) {
  const t = useT();
  const headingId = `${sectionId}-roles`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const showAdd = canManage && assignableRoles.length > 0 && Boolean(onAdd);
  if (!loading && roles.length === 0 && !showAdd && !error) return null;
  const removable = new Set(removableRoleIds);
  return (
    <section aria-labelledby={headingId} aria-busy={busy || undefined}>
      <SectionHeading id={headingId}>{t('shell.profile.roles')}</SectionHeading>
      {loading && roles.length === 0 ? (
        <div className="flex gap-1.5 py-1">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      ) : (
        <ul className="flex flex-wrap items-center gap-1.5">
          {roles.map((role) => (
            <li
              key={role.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-container-high py-1 pl-2 pr-2 text-xs font-medium text-text-primary"
            >
              <RoleDot role={role} />
              <span className="truncate">{role.name.replace(/^@/, '')}</span>
              {canManage && removable.has(role.id) && onRemove ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(role.id)}
                  aria-label={t('shell.profile.removeRole', { role: role.name })}
                  title={t('shell.profile.removeRole', { role: role.name })}
                  className="-mr-1 grid size-4 place-items-center rounded text-text-secondary hover:bg-danger/15 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden>close</span>
                </button>
              ) : null}
            </li>
          ))}
          {showAdd ? (
            <li className="relative">
              <button
                ref={addButtonRef}
                type="button"
                disabled={busy}
                onClick={() => setPickerOpen((value) => !value)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label={t('shell.profile.addRole')}
                title={t('shell.profile.addRole')}
                className="grid size-6 place-items-center rounded-md bg-surface-container-high text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden>add</span>
              </button>
              {pickerOpen ? (
                <RolePicker
                  roles={assignableRoles}
                  onPick={(roleId) => {
                    setPickerOpen(false);
                    addButtonRef.current?.focus();
                    onAdd?.(roleId);
                  }}
                  onDismiss={() => {
                    setPickerOpen(false);
                    addButtonRef.current?.focus();
                  }}
                />
              ) : null}
            </li>
          ) : null}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The "+" role list: arrow keys move, Enter picks, Escape closes. */
function RolePicker({
  roles,
  onPick,
  onDismiss,
}: {
  roles: ProfileRoleView[];
  onPick: (roleId: string) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const listId = useId();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (listRef.current && !listRef.current.parentElement?.contains(target)) onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onDismiss]);

  return (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      tabIndex={0}
      aria-label={t('shell.profile.addRole')}
      aria-activedescendant={roles[active] ? `${listId}-${roles[active]!.id}` : undefined}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => (index + 1) % roles.length);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (index - 1 + roles.length) % roles.length);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setActive(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          setActive(roles.length - 1);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const role = roles[active];
          if (role) onPick(role.id);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        } else if (event.key === 'Tab') {
          onDismiss();
        }
      }}
      className="absolute left-0 top-full z-10 mt-1 max-h-56 w-56 overflow-y-auto rounded-lg border border-border-subtle bg-surface-floating p-1 shadow-xl outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      {roles.map((role, index) => (
        <li
          key={role.id}
          id={`${listId}-${role.id}`}
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(role.id)}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-primary ${
            index === active ? 'bg-surface-container-high' : ''
          }`}
        >
          <RoleDot role={role} />
          <span className="truncate">{role.name}</span>
        </li>
      ))}
    </ul>
  );
}

function ServerBubble({ server, sizeClass = 'size-7' }: { server: MutualServerView; sizeClass?: string }) {
  const t = useT();
  return (
    <span
      className={`grid ${sizeClass} flex-none place-items-center overflow-hidden rounded-full border-2 border-surface-container bg-surface-container-high text-[11px] font-bold text-text-primary`}
      title={server.name}
    >
      {server.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- https community icons only (never data URLs)
        <img src={server.iconUrl} alt="" className="size-full object-cover" />
      ) : (
        <span aria-hidden>{initialOf(server.name, { locale: t.locale })}</span>
      )}
    </span>
  );
}

/** Count plus the first few community icons; opens the full list. */
export function MutualServersStrip({
  servers,
  count,
  onOpen,
  sectionId,
}: {
  servers: MutualServerView[];
  count: number;
  onOpen?: () => void;
  sectionId: string;
}) {
  const t = useT();
  const headingId = `${sectionId}-mutual`;
  if (count <= 0) return null;
  const label = t('shell.profile.mutualCount', { count });
  const content = (
    <>
      <span className="flex -space-x-2" aria-hidden>
        {servers.slice(0, 4).map((server) => (
          <ServerBubble key={server.id} server={server} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{label}</span>
      {onOpen ? <span className="material-symbols-outlined text-[18px] text-text-secondary" aria-hidden>chevron_right</span> : null}
    </>
  );
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId}>{t('shell.profile.mutualCommunities')}</SectionHeading>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-1 py-1">{content}</div>
      )}
    </section>
  );
}

/** The full list (the full profile's tab): icon and name, each a link to that community's lobby. */
export function MutualServersList({
  servers,
  count,
  currentServerId,
  loading,
}: {
  servers: MutualServerView[];
  count: number;
  currentServerId: string;
  loading?: boolean;
}) {
  const t = useT();
  if (loading) {
    return (
      <div className="space-y-2 py-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (servers.length === 0) {
    return <p className="py-6 text-center text-sm text-text-secondary">{t('shell.profile.noMutual')}</p>;
  }
  return (
    <div>
      <ul className="space-y-1">
        {servers.map((server) => (
          <li key={server.id}>
            <a
              href={`/lobby?server=${encodeURIComponent(server.id)}`}
              aria-current={server.id === currentServerId ? 'page' : undefined}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-text-primary hover:bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <ServerBubble server={server} sizeClass="size-9" />
              <span className="min-w-0 flex-1 truncate font-medium">{server.name}</span>
              {server.id === currentServerId ? (
                <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                  {t('shell.profile.currentCommunity')}
                </span>
              ) : (
                <span className="material-symbols-outlined text-[18px] text-text-secondary" aria-hidden>chevron_right</span>
              )}
            </a>
          </li>
        ))}
      </ul>
      {count > servers.length ? (
        <p className="mt-2 text-xs text-text-secondary">{t('shell.profile.mutualMore', { count: count - servers.length })}</p>
      ) : null}
    </div>
  );
}

/** The limited-profile line: details withheld (a private profile, or a block — which is not said). */
export function LimitedNotice() {
  const t = useT();
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-container px-3 py-2 text-sm text-text-secondary">
      <span className="material-symbols-outlined text-[18px]" aria-hidden>visibility_off</span>
      {t('shell.profile.limited')}
    </p>
  );
}
