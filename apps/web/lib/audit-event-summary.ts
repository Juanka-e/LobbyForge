/**
 * Audit log rows as moderators read them: the shape the audit page hands
 * its client, and a one-line human summary for the actions that need one
 * — the voice anti-cheat removals and the moderator voice disconnect —
 * instead of a raw id and a JSON blob.
 *
 * Client-safe (no database, no Redis): the audit client renders the
 * summary, the CSV export and the search box all read it from here.
 */
import type { Params, Translator } from '@/lib/i18n/core';
import { isTrackKindAllowedForSource } from '@/lib/voice-track-policy';

export interface AuditEntryView {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
  /** Display name of a `user` target, resolved on the server (null when unknown or deleted). */
  targetName: string | null;
  /** Name of the channel in `metadata.channelId`, when the viewer may see that channel. */
  channelName: string | null;
  createdAt: string;
}

/** The audit actions the "Voice security" filter collects. */
export const VOICE_SECURITY_ACTIONS: ReadonlySet<string> = new Set([
  'voice.track_rejected',
  'voice.block_enforced',
  'voice.disconnect',
]);

const TRACK_TYPES = new Set(['audio', 'video', 'data']);
const TRACK_SOURCES = new Set(['camera', 'microphone', 'screen_share', 'screen_share_audio']);

/**
 * A summary's catalogue key, split by where its values come from:
 *
 *  - `params` choose the sentence (plural minutes, known/unknown channel)
 *    and go through `t` as usual;
 *  - `slots` carry data — a channel name, a phrase quoting a client's mime
 *    type — and, like `{actor}` and `{target}`, are filled in by the
 *    caller: as plain text (CSV, search) or as elements with `rich()`, so
 *    a channel called "{target}" can never be read as a marker.
 */
export interface AuditSummaryMessage {
  key: string;
  params: Params;
  slots: Record<string, string>;
}

/** The summary for an entry, or null for an action that has none. */
export function auditEventSummary(t: Translator, entry: AuditEntryView): AuditSummaryMessage | null {
  const meta = entry.metadata ?? {};
  const params: Params = { channelKnown: entry.channelName ? 'yes' : 'no' };
  const slots: Record<string, string> = { channel: entry.channelName ?? '' };
  switch (entry.action) {
    case 'voice.track_rejected': {
      const blockedSeconds = positiveNumber(meta.blockedSeconds);
      slots.offence = trackOffence(t, meta);
      if (blockedSeconds === null) return { key: 'admin.audit.event.trackRejectedNoBlock', params, slots };
      return {
        key: 'admin.audit.event.trackRejected',
        params: { ...params, minutes: wholeMinutes(blockedSeconds) },
        slots,
      };
    }
    case 'voice.block_enforced':
      return {
        key: 'admin.audit.event.blockEnforced',
        params: { ...params, minutes: wholeMinutes(positiveNumber(meta.retryAfterSeconds) ?? 60) },
        slots,
      };
    case 'voice.disconnect':
      return { key: 'admin.audit.event.disconnect', params, slots };
    case 'instance.captcha_updated': {
      // Bot protection settings: the NAMES of the fields that changed, never
      // their values (a secret key among them).
      const fields = captchaFieldNames(meta.fields).map((field) => t(`admin.audit.captchaField.${field}`));
      if (fields.length === 0) return { key: 'admin.audit.event.captchaUpdatedNoFields', params, slots };
      return { key: 'admin.audit.event.captchaUpdated', params, slots: { ...slots, fields: listFormat(t.locale, fields) } };
    }
    case 'instance.mail_updated': {
      // Email settings (docs/EMAIL.md §5): field NAMES only, never values
      // (the SMTP password among them).
      const fields = knownFields(meta.fields, MAIL_FIELDS).map((field) => t(`admin.audit.mailField.${field}`));
      if (fields.length === 0) return { key: 'admin.audit.event.mailUpdatedNoFields', params, slots };
      return { key: 'admin.audit.event.mailUpdated', params, slots: { ...slots, fields: listFormat(t.locale, fields) } };
    }
    case 'user.email_verified_by_admin':
      return { key: 'admin.audit.event.emailVerifiedByAdmin', params, slots };
    default:
      return null;
  }
}

const CAPTCHA_FIELDS = ['provider', 'surfaces', 'siteKey', 'secretKey', 'options', 'attackMode'] as const;
const MAIL_FIELDS = [
  'provider',
  'region',
  'host',
  'port',
  'security',
  'username',
  'password',
  'from',
  'dailyLimit',
  'verificationMode',
  'verificationScope',
  'existingDeadline',
  'disposableBlock',
  'disposableAllow',
  'disposableBlockExtra',
] as const;

/** The known field names in an entry's `metadata.fields`, in the fixed order of `known`. */
function knownFields<T extends string>(value: unknown, known: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  return known.filter((field) => value.includes(field));
}

/** "a, b and c" in the reader's language. */
function listFormat(locale: string, items: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** The known field names in an `instance.captcha_updated` entry, in a fixed order. */
function captchaFieldNames(value: unknown): Array<(typeof CAPTCHA_FIELDS)[number]> {
  if (!Array.isArray(value)) return [];
  return CAPTCHA_FIELDS.filter((field) => value.includes(field));
}

/**
 * How a target reads: "Name (0a1b2c3d…)" when the name is known, the
 * shortened id otherwise. The full id stays available to the caller.
 */
export function auditTargetLabel(t: Translator, entry: Pick<AuditEntryView, 'targetId' | 'targetName'>): string {
  if (!entry.targetId) return entry.targetName ?? '';
  const id = shortId(entry.targetId);
  return entry.targetName ? t('admin.audit.targetWithId', { name: entry.targetName, id }) : id;
}

/** The summary as plain text — for the CSV export and the search box. */
export function auditEventSummaryText(t: Translator, entry: AuditEntryView): string {
  const summary = auditEventSummary(t, entry);
  if (!summary) return '';
  return t(summary.key, {
    ...summary.params,
    ...summary.slots,
    actor: entry.actorName ?? t('admin.audit.systemActor'),
    target: auditTargetLabel(t, entry),
  });
}

/** First 8 characters of an id, then an ellipsis. */
export function shortId(id: string): string {
  return id.length > 9 ? `${id.slice(0, 8)}…` : id;
}

/** What the removed track did wrong, as a phrase that follows a colon. */
function trackOffence(t: Translator, meta: Record<string, unknown>): string {
  const type = typeof meta.type === 'string' && TRACK_TYPES.has(meta.type) ? meta.type : 'unknown';
  const source = typeof meta.source === 'string' && TRACK_SOURCES.has(meta.source) ? meta.source : 'unknown';
  const typeWord = t(`admin.audit.trackType.${type}`);
  // Kind and source agree, so the MEDIA gave it away (a "video" camera
  // track carrying audio): "video published as camera" would read as fine.
  if (typeof meta.mimeType === 'string' && meta.mimeType && isTrackKindAllowedForSource(type, source)) {
    return t('admin.audit.offence.mediaMismatch', { type: typeWord, mimeType: meta.mimeType });
  }
  return t('admin.audit.offence.mislabelled', { type: typeWord, source: t(`admin.audit.trackSource.${source}`) });
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Seconds as whole minutes, rounded up, never 0. */
function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}
