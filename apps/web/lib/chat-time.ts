import type { Translator } from '@/lib/i18n/core';

/**
 * How a message is stamped in every transcript — channels and DMs.
 *
 * design pass: every message carried the same absolute stamp
 * ("22 Eyl 11:34"), which tells you the date of a message you are
 * reading right now and buries the one fact you usually want: whether
 * something happened today. Recent messages read relatively, older ones
 * absolutely, and the exact instant is always one hover away.
 *
 * i18n pass: the phrasing is NOT assembled here. "Today at 11:34" is
 * "Bugün 11:34" in Turkish — no preposition at all — so a translated
 * "Today" glued to a hardcoded " at " cannot come out right in both.
 * The caller hands in its translator and the catalogue carries the
 * whole phrase around a `{time}` placeholder.
 *
 * These stay pure functions: no hooks, no locale detection of their
 * own. They are called from client components, from server components
 * and from the unit tests, and all three have to agree.
 */

const DAY_MS = 86_400_000;

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days between two instants, by calendar day, not by elapsed time. */
function daysApart(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

/**
 * Which locale `Intl` should format dates and times with.
 *
 * The month names have to match the sentence around them — "Bugün
 * 11:34" above a separator reading "23 September 2026" is just wrong.
 * But switching a British user to the app's `en` would also switch them
 * from 22/09/2026 to 09/22/2026, which nobody asked for. So: keep the
 * browser's own locale when it speaks the same language as the app, and
 * fall back to the app's language only when they disagree.
 */
function intlLocale(t: Translator): string | undefined {
  if (typeof navigator === 'undefined') return t.locale;
  const preferred = navigator.languages?.[0] ?? navigator.language;
  if (!preferred) return t.locale;
  const language = preferred.toLowerCase().split(/[-_]/)[0];
  return language === t.locale ? preferred : t.locale;
}

export function isSameDay(a: string | Date, b: string | Date): boolean {
  const first = toDate(a);
  const second = toDate(b);
  if (!first || !second) return false;
  return startOfDay(first) === startOfDay(second);
}

function time(date: Date, locale: string | undefined): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The stamp beside an author's name: "Today at 11:34",
 * "Yesterday at 11:34", or "22/09/2026 11:34" once it is older.
 */
export function formatMessageTimestamp(
  value: string | Date,
  t: Translator,
  now: Date = new Date()
): string {
  const date = toDate(value);
  if (!date) return typeof value === 'string' ? value : '';
  const days = daysApart(date, now);
  if (days === 0) return t('lobbyMain.time.todayAt', { time: time(date, intlLocale(t)) });
  if (days === 1) return t('lobbyMain.time.yesterdayAt', { time: time(date, intlLocale(t)) });
  return t('lobbyMain.time.dateAt', {
    date: date.toLocaleDateString(intlLocale(t), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }),
    time: time(date, intlLocale(t)),
  });
}

/** The divider between days: "Today", "Yesterday", "22 September 2026". */
export function formatDaySeparator(
  value: string | Date,
  t: Translator,
  now: Date = new Date()
): string {
  const date = toDate(value);
  if (!date) return '';
  const days = daysApart(date, now);
  if (days === 0) return t('lobbyMain.time.today');
  if (days === 1) return t('lobbyMain.time.yesterday');
  return date.toLocaleDateString(intlLocale(t), {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** The full instant, for the `title` tooltip — never abbreviated. */
export function formatFullTimestamp(value: string | Date, t: Translator): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString(intlLocale(t), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
