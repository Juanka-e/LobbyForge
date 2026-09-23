/**
 * How a message is stamped in every transcript — channels and DMs.
 *
 * design pass: every message carried the same absolute stamp
 * ("22 Eyl 11:34"), which tells you the date of a message you are
 * reading right now and buries the one fact you usually want: whether
 * something happened today. Recent messages read relatively, older ones
 * absolutely, and the exact instant is always one hover away.
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

export function isSameDay(a: string | Date, b: string | Date): boolean {
  const first = toDate(a);
  const second = toDate(b);
  if (!first || !second) return false;
  return startOfDay(first) === startOfDay(second);
}

function time(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The stamp beside an author's name: "Today at 11:34",
 * "Yesterday at 11:34", or "22/09/2026 11:34" once it is older.
 */
export function formatMessageTimestamp(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return typeof value === 'string' ? value : '';
  const days = daysApart(date, now);
  if (days === 0) return `Today at ${time(date)}`;
  if (days === 1) return `Yesterday at ${time(date)}`;
  return `${date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })} ${time(date)}`;
}

/** The divider between days: "Today", "Yesterday", "22 September 2026". */
export function formatDaySeparator(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const days = daysApart(date, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** The full instant, for the `title` tooltip — never abbreviated. */
export function formatFullTimestamp(value: string | Date): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
