'use client';

import { useT } from '@/lib/i18n/client';

/**
 * How a post from an incoming channel webhook looks (BOT_API_V2 §5.1): a
 * webhook avatar instead of a person's initial, and a `WEBHOOK` badge next
 * to the name — like a bot, an outside service must never pass for a
 * member. Outlined (not the bot's solid accent) so the two read as
 * different things at a glance, in every theme.
 */

export function WebhookBadge({ className = '' }: { className?: string }) {
  const t = useT();
  return (
    <span
      data-webhook-badge
      title={t('interactions.webhook.badgeTitle')}
      className={`inline-flex flex-none items-center rounded border border-primary px-1 text-[10px] font-bold leading-4 tracking-wide text-primary ${className}`}
    >
      {t('interactions.webhook.badge')}
    </span>
  );
}

export function WebhookAvatar({ className = '' }: { className?: string }) {
  return (
    <span
      data-webhook-avatar
      aria-hidden
      className={`grid size-10 flex-none place-items-center rounded-full border border-border-strong bg-surface-container text-[22px] text-primary ${className}`}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 'inherit' }}>webhook</span>
    </span>
  );
}
