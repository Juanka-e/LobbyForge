'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ProfileRole {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  position?: number;
  displaySeparately?: boolean;
}

export interface UserProfilePopoverProps {
  open: boolean;
  onClose: () => void;
  user: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    bannerUrl?: string | null;
    isGuest: boolean;
    roleName?: string | null;
    roleColor?: string | null;
    statusText?: string | null;
    bio?: string | null;
    roles?: ProfileRole[];
    onlineStatus?: 'online' | 'in_voice' | 'idle' | 'offline';
  } | null;
  anchorRect?: DOMRect | null;
  getVolume?: (userId: string) => number;
  onVolumeChange?: (userId: string, volume: number) => void;
  isBlocked?: boolean;
  onToggleBlock?: (userId: string) => void;
  /** Open a DM channel with this user. Hidden when not provided (e.g. self). */
  onSendMessage?: (userId: string) => void;
}

const STATUS = {
  online: { label: 'Online', dot: 'bg-success' },
  in_voice: { label: 'In voice', dot: 'bg-success' },
  idle: { label: 'Idle', dot: 'bg-tertiary' },
  offline: { label: 'Offline', dot: 'bg-text-muted' },
} as const;

export function UserProfilePopover({
  open,
  onClose,
  user,
  anchorRect,
  getVolume,
  onVolumeChange,
  isBlocked,
  onToggleBlock,
  onSendMessage,
}: UserProfilePopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [volume, setVolume] = useState(1);

  useLayoutEffect(() => {
    if (!open || !user || !anchorRect) return setPosition(null);
    const width = Math.min(360, window.innerWidth - 24);
    const margin = 12;
    let left = anchorRect.left - width - margin;
    if (left < margin) left = Math.min(anchorRect.right + margin, window.innerWidth - width - margin);
    const estimatedHeight = Math.min(560, window.innerHeight - margin * 2);
    const top = Math.max(margin, Math.min(anchorRect.top - 24, window.innerHeight - estimatedHeight - margin));
    setPosition({ left, top });
  }, [open, user, anchorRect]);

  useEffect(() => {
    if (open && user && getVolume) setVolume(getVolume(user.userId));
  }, [open, user, getVolume]);

  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement | null)?.closest('[data-user-popover-anchor]')) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose]);

  if (!open || !user || typeof document === 'undefined') return null;

  const status = STATUS[user.onlineStatus ?? 'offline'];
  const roles = (user.roles?.length
    ? user.roles
    : user.roleName
      ? [{ id: user.roleName, name: user.roleName, color: user.roleColor ?? null, icon: null }]
      : []).filter((role) => role.name !== '@everyone');
  const showVolume = user.onlineStatus === 'in_voice' && Boolean(getVolume && onVolumeChange);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${user.displayName} profile`}
      className="fixed z-[70] max-h-[calc(100dvh-24px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto overflow-x-hidden rounded-lg border border-border-strong bg-surface-floating shadow-2xl"
      style={position ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
    >
      <div
        className="h-[104px] bg-surface-container-high bg-cover bg-center"
        style={user.bannerUrl ? { backgroundImage: `url(${user.bannerUrl})` } : undefined}
        aria-hidden
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close profile"
        className="absolute right-3 top-3 grid size-8 place-items-center rounded-md bg-black/55 text-white transition-colors hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden>close</span>
      </button>

      <div className="px-4 pb-4">
        <div className="relative -mt-10 mb-3 size-20">
          <div className="size-20 overflow-hidden rounded-full border-[5px] border-surface-floating bg-surface-container">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- User avatars may be validated data URLs.
              <img src={user.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-3xl font-semibold text-text-primary">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <span className={`absolute bottom-1 right-1 size-[18px] rounded-full border-[4px] border-surface-floating ${status.dot}`} aria-label={status.label} />
        </div>

        <div className="min-w-0">
          <h2 className="break-words text-xl font-bold leading-tight text-text-primary">{user.displayName}</h2>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-text-secondary">
            <span className={`size-2 flex-none rounded-full ${status.dot}`} aria-hidden />
            <span className="flex-none">{status.label}</span>
            {user.isGuest ? (
              <>
                <span className="text-text-muted" aria-hidden>·</span>
                <span className="truncate text-text-muted">Guest</span>
              </>
            ) : null}
          </div>
          {user.statusText ? <p className="mt-2 break-words text-sm leading-5 text-text-secondary">{user.statusText}</p> : null}
        </div>

        <div className="my-4 h-px bg-border-subtle" />

        <section aria-labelledby={`profile-about-${user.userId}`}>
          <h3 id={`profile-about-${user.userId}`} className="text-xs font-bold uppercase text-text-primary">About me</h3>
          <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-5 ${user.bio ? 'text-text-secondary' : 'italic text-text-muted'}`}>
            {user.bio || 'No bio yet.'}
          </p>
        </section>

        {roles.length ? (
          <section className="mt-5" aria-labelledby={`profile-roles-${user.userId}`}>
            <h3 id={`profile-roles-${user.userId}`} className="text-xs font-bold uppercase text-text-primary">Roles</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {roles.map((role) => (
                <span key={role.id} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-subtle bg-surface-container px-2 py-1 text-xs font-medium text-text-secondary">
                  {role.icon ? (
                    <span className="material-symbols-outlined text-[14px]" style={{ color: role.color ?? undefined }} aria-hidden>{role.icon}</span>
                  ) : (
                    <span className="size-2 rounded-full bg-current" style={{ color: role.color ?? undefined }} aria-hidden />
                  )}
                  <span className="truncate">{role.name.replace(/^@/, '')}</span>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {showVolume ? (
          <section className="mt-5 border-t border-border-subtle pt-4">
            <div className="mb-3 flex items-center justify-between text-sm text-text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[17px]" aria-hidden>{volume === 0 ? 'volume_off' : 'volume_up'}</span>
                User volume
              </span>
              <output>{Math.round(volume * 100)}%</output>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(event) => {
                const next = Number(event.target.value) / 100;
                setVolume(next);
                onVolumeChange?.(user.userId, next);
              }}
              className="h-1.5 w-full accent-primary"
              aria-label={`Volume for ${user.displayName}`}
            />
          </section>
        ) : null}

        {onSendMessage ? (
          <button
            type="button"
            onClick={() => onSendMessage(user.userId)}
            disabled={isBlocked}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[17px]" aria-hidden>mail</span>
            Send message
          </button>
        ) : null}

        {onToggleBlock ? (
          <button
            type="button"
            onClick={() => onToggleBlock(user.userId)}
            className={`mt-5 inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-semibold transition-colors ${isBlocked ? 'border-border-strong text-text-secondary hover:bg-surface-container' : 'border-danger/40 text-danger hover:bg-danger/10'}`}
          >
            <span className="material-symbols-outlined text-[17px]" aria-hidden>{isBlocked ? 'remove_circle' : 'block'}</span>
            {isBlocked ? 'Unblock user' : 'Block user'}
          </button>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
