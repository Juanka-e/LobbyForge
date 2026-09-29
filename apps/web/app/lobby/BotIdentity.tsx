'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/client';
import type { BotTrustLevel } from '@/lib/bots/catalog';

/**
 * How a bot looks wherever it appears (members, messages): a robot avatar
 * on the accent colour instead of a person's initial or photo, and a
 * `BOT` badge next to the name — a bot must never pass for a person.
 * Solid accent + on-accent keeps both readable in every theme.
 */

export interface LobbyBot {
  id: string;
  name: string;
  type: string;
  builtIn: boolean;
  trustLevel: BotTrustLevel;
  permissions: string[];
  /** Display name of whoever installed it; null when unknown. */
  installedBy: string | null;
}

export function BotBadge({ className = '' }: { className?: string }) {
  const t = useT();
  return (
    <span
      data-bot-badge
      title={t('lobbyMain.bots.badgeTitle')}
      className={`inline-flex flex-none items-center rounded bg-primary px-1 py-px text-[10px] font-bold leading-4 tracking-wide text-on-primary ${className}`}
    >
      {t('lobbyMain.chat.botBadge')}
    </span>
  );
}

const AVATAR_SIZE = {
  sm: 'size-8 text-[18px]',
  md: 'size-10 text-[22px]',
  lg: 'size-20 text-[44px]',
} as const;

export function BotAvatar({ size = 'md', className = '' }: { size?: keyof typeof AVATAR_SIZE; className?: string }) {
  return (
    <span
      data-bot-avatar
      aria-hidden
      className={`grid flex-none place-items-center rounded-full bg-primary text-on-primary ${AVATAR_SIZE[size]} ${className}`}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 'inherit' }}>smart_toy</span>
    </span>
  );
}

const TRUST_KEY: Record<BotTrustLevel, string> = {
  official: 'bots.trust.official',
  verified: 'bots.trust.verified',
  unverified: 'bots.trust.unverified',
};

/** Keys, not text: resolved with `t()` where they render. */
const PERMISSION_KEY: Record<string, string> = {
  read_messages: 'bots.permission.read_messages',
  send_messages: 'bots.permission.send_messages',
  join_voice: 'bots.permission.join_voice',
  publish_audio: 'bots.permission.publish_audio',
  read_presence: 'bots.permission.read_presence',
  moderate_messages: 'bots.permission.moderate_messages',
  manage_game_session: 'bots.permission.manage_game_session',
  manage_music_queue: 'bots.permission.manage_music_queue',
  read_audit_log: 'bots.permission.read_audit_log',
};

export function botPermissionLabelKey(permission: string): string | null {
  return PERMISSION_KEY[permission] ?? null;
}

export function TrustBadge({ level }: { level: BotTrustLevel }) {
  const t = useT();
  const tone =
    level === 'official'
      ? 'border-success/40 text-success'
      : level === 'verified'
        ? 'border-primary/40 text-text-secondary'
        : 'border-border-strong text-text-secondary';
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium ${tone}`}>
      <span className="material-symbols-outlined text-[13px]" aria-hidden>
        {level === 'official' ? 'verified' : level === 'verified' ? 'check_circle' : 'help'}
      </span>
      {t(TRUST_KEY[level])}
    </span>
  );
}

/**
 * The bot profile: who it is, who installed it and what it may do.
 * Managers get a shortcut to the bot settings. Same placement and
 * dismissal rules as the member profile popover.
 */
export function BotProfilePopover({
  bot,
  anchorRect,
  onClose,
  canManage,
}: {
  bot: LobbyBot;
  anchorRect: DOMRect | null;
  onClose: () => void;
  canManage: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRect) return setPosition(null);
    const width = Math.min(320, window.innerWidth - 24);
    const margin = 12;
    let left = anchorRect.left - width - margin;
    if (left < margin) left = Math.min(anchorRect.right + margin, window.innerWidth - width - margin);
    const estimatedHeight = Math.min(420, window.innerHeight - margin * 2);
    const top = Math.max(margin, Math.min(anchorRect.top - 24, window.innerHeight - estimatedHeight - margin));
    setPosition({ left, top });
  }, [anchorRect]);

  useEffect(() => {
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
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t('bots.profile.dialogLabel', { name: bot.name })}
      className="fixed z-[70] max-h-[calc(100dvh-24px)] w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border border-border-strong bg-surface-floating p-4 shadow-2xl"
      style={position ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t('bots.profile.close')}
        className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden>close</span>
      </button>

      <div className="flex items-center gap-3 pr-8">
        <BotAvatar size="md" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-lg font-bold leading-tight text-text-primary">{bot.name}</h2>
            <BotBadge />
          </div>
          <div className="mt-1">
            <TrustBadge level={bot.trustLevel} />
          </div>
        </div>
      </div>

      <div className="my-4 h-px bg-border-subtle" />

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-bold text-text-primary">{t('bots.profile.kind')}</dt>
          <dd className="mt-1 text-text-secondary">
            {bot.builtIn ? t('bots.profile.kindBuiltIn') : t('bots.profile.kindCustom')}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-text-primary">{t('bots.profile.installedBy')}</dt>
          <dd className="mt-1 text-text-secondary">{bot.installedBy ?? t('bots.profile.installedByUnknown')}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold text-text-primary">{t('bots.profile.permissions')}</dt>
          <dd className="mt-2 flex flex-wrap gap-1.5">
            {bot.permissions.length === 0 ? (
              <span className="text-text-muted">{t('bots.profile.noPermissions')}</span>
            ) : (
              bot.permissions.map((permission) => {
                const key = botPermissionLabelKey(permission);
                return (
                  <span
                    key={permission}
                    className="rounded-md border border-border-subtle bg-surface-container px-2 py-1 text-xs text-text-secondary"
                  >
                    {key ? t(key) : permission}
                  </span>
                );
              })
            )}
          </dd>
        </div>
      </dl>

      {canManage ? (
        <a
          href="/admin/settings/bots"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden>settings</span>
          {t('bots.profile.configure')}
        </a>
      ) : null}
    </div>,
    document.body
  );
}
