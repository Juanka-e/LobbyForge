'use client';

import { useT } from '@/lib/i18n/client';

/**
 * How an app message looks: a line a game plugin posted during an activity
 * (`chat.post`, docs/PLUGIN_SDK.md "Effects"). An app avatar instead of a
 * person's initial and an `APP` badge next to its name — like a bot or a
 * webhook, an app must never pass for a member. Tonal (neither the bot's
 * solid accent nor the webhook's outline) so the three read as different
 * things at a glance, in every theme.
 */

export function AppBadge({ name, className = '' }: { name: string; className?: string }) {
  const t = useT();
  return (
    <span
      data-app-badge
      title={t('lobbyMain.chat.appBadgeTitle', { name })}
      className={`inline-flex flex-none items-center rounded border border-border-subtle bg-surface-container-high px-1 text-[10px] font-bold leading-4 tracking-wide text-text-primary ${className}`}
    >
      {t('lobbyMain.chat.appBadge')}
    </span>
  );
}

export function AppAvatar({ className = '' }: { className?: string }) {
  return (
    <span
      data-app-avatar
      aria-hidden
      className={`grid size-10 flex-none place-items-center rounded-full border border-border-strong bg-surface-container-high text-[22px] text-text-secondary ${className}`}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 'inherit' }}>sports_esports</span>
    </span>
  );
}
