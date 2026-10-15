/**
 * A refused chat post or edit, explained in the writer's language — never
 * the server's English `error` text. Client-safe.
 */
import type { Translator } from '@/lib/i18n/core';
import { moderationBlockedMessageKey } from '@/lib/bots/catalog';

/** Why a post or edit was refused (status + the route's `code`). */
export function composerRefusalMessage(
  t: Translator,
  status: number,
  detail: { code?: string; rule?: string; until?: string }
): string {
  // The Moderation Bot's refusal is explained in the reader's language.
  if (detail.code === 'blocked_by_moderation') return t(moderationBlockedMessageKey(detail.rule));
  // `actor_timed_out`: a timed-out moderator deleting or pinning someone
  // else's message (lib/actor-timeout.ts) — the same words.
  if (detail.code === 'timed_out' || detail.code === 'actor_timed_out') {
    const until = detail.until ? new Date(detail.until) : null;
    return until && !Number.isNaN(until.getTime())
      ? t('lobbyMain.composer.timedOutUntil', {
          time: new Intl.DateTimeFormat(t.locale, { dateStyle: 'short', timeStyle: 'short' }).format(until),
        })
      : t('lobbyMain.composer.timedOut');
  }
  if (detail.code === 'mention_everyone_forbidden') return t('lobbyMain.composer.mentionEveryoneForbidden');
  if (status === 403) return t('lobbyMain.composer.forbidden');
  if (status === 429) return t('lobbyMain.composer.rateLimited');
  return t('lobbyMain.composer.failed', { status });
}
