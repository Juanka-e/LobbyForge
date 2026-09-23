'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import {
  PRESENCE_DESCRIPTION_KEYS,
  PRESENCE_DOT_CLASS,
  PRESENCE_ICONS,
  PRESENCE_LABEL_KEYS,
  PRESENCE_STATUSES,
  type PresenceStatus,
} from '@/lib/presence-status';

/**
 * The account block at the bottom of the sidebar: avatar, display name,
 * and the status picker it opens.
 *
 * beta-review: this block showed the literal word "You" instead of the
 * user's nickname, and its dot was green whenever LiveKit was connected
 * — so a user who was simply online (but not in a voice channel) looked
 * offline, and there was no way to change status at all.
 */

export interface LobbyPresenceMenuProps {
  displayName: string;
  /** Falls back to a "Guest" label when there is no account. */
  hasUser: boolean;
  status: PresenceStatus;
  onChange: (status: PresenceStatus) => void;
  /** Sub-label under the name — the voice state, when connected. */
  voiceLabel: string | null;
}

export function LobbyPresenceMenu({
  displayName,
  hasUser,
  status,
  onChange,
  voiceLabel,
}: LobbyPresenceMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const name = hasUser
    ? displayName.trim() || t('lobby.presence.you')
    : t('common.guest');
  const initial = name.charAt(0).toUpperCase() || '?';
  const subLabel = voiceLabel ?? t(PRESENCE_LABEL_KEYS[status]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasUser}
        aria-expanded={open}
        aria-haspopup="menu"
        title={hasUser ? t('lobby.presence.trigger', { name }) : t('lobby.presence.guestSession')}
        className="flex items-center gap-2 min-w-0 rounded-md p-1 -m-1 text-left hover:bg-surface-container transition-colors disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="w-8 h-8 rounded-full bg-secondary-container relative flex-shrink-0">
          <span className="absolute inset-0 flex items-center justify-center text-label-sm font-bold text-text-primary">
            {initial}
          </span>
          <div
            aria-label={t(PRESENCE_LABEL_KEYS[status])}
            className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-raised ${PRESENCE_DOT_CLASS[status]}`}
          />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-[13px] text-text-primary font-medium truncate">{name}</span>
          <span className="text-[11px] text-text-secondary truncate">{subLabel}</span>
        </div>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t('lobby.presence.menuLabel')}
          className="absolute bottom-[110%] left-0 z-50 w-64 rounded-lg border border-border-subtle bg-surface-floating p-2 shadow-xl"
        >
          {PRESENCE_STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === status}
              onClick={() => {
                onChange(option);
                close();
              }}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-container ${
                option === status ? 'bg-surface-container' : ''
              }`}
            >
              <span
                className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${PRESENCE_DOT_CLASS[option]}`}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm text-text-primary">
                  {t(PRESENCE_LABEL_KEYS[option])}
                  {option === status ? (
                    <span className="material-symbols-outlined text-[14px] text-primary">check</span>
                  ) : null}
                </span>
                <span className="block text-[11px] leading-snug text-text-secondary">
                  {t(PRESENCE_DESCRIPTION_KEYS[option])}
                </span>
              </span>
              <span className="material-symbols-outlined ml-auto text-[16px] text-text-muted">
                {PRESENCE_ICONS[option]}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-border-subtle" />
          <Link
            role="menuitem"
            href="/settings"
            onClick={close}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
          >
            <span className="material-symbols-outlined text-[18px]">manage_accounts</span>
            {t('lobby.presence.accountSettings')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
