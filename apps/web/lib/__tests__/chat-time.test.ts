import { describe, expect, it } from 'vitest';
import {
  formatDaySeparator,
  formatFullTimestamp,
  formatMessageTimestamp,
  isSameDay,
} from '../chat-time.js';
import { createTranslator } from '../i18n/messages.js';

/**
 * Relative dates are the kind of thing that silently drifts: an
 * off-by-one in the day maths only shows up as "Yesterday" on a message
 * sent this morning, which nobody reports as a bug. The boundaries are
 * pinned here against a fixed `now`.
 *
 * The phrasing comes from the caller's translator, so the same day
 * maths is checked in both languages — Turkish reads "Bugün 11:34",
 * with no preposition, which is exactly the shape a concatenated
 * "Today" + " at " could never produce.
 */
const NOW = new Date(2026, 8, 23, 14, 30); // 23 Sep 2026, 14:30 local

const at = (day: number, hour = 11, minute = 34) => new Date(2026, 8, day, hour, minute);

const en = createTranslator('en');
const tr = createTranslator('tr');

describe('formatMessageTimestamp', () => {
  it('reads relatively for today', () => {
    expect(formatMessageTimestamp(at(23), en, NOW)).toMatch(/^Today at /);
  });

  it('reads relatively for yesterday', () => {
    expect(formatMessageTimestamp(at(22), en, NOW)).toMatch(/^Yesterday at /);
  });

  it('falls back to an absolute date once older', () => {
    const stamp = formatMessageTimestamp(at(21), en, NOW);
    expect(stamp).not.toMatch(/Today|Yesterday/);
    expect(stamp).toContain('2026');
  });

  it('counts calendar days, not elapsed hours', () => {
    // 00:10 today vs 23:50 yesterday is 20 minutes apart, but they are
    // different days and must read that way.
    const justAfterMidnight = new Date(2026, 8, 23, 0, 10);
    const justBefore = new Date(2026, 8, 22, 23, 50);
    expect(formatMessageTimestamp(justAfterMidnight, en, NOW)).toMatch(/^Today at /);
    expect(formatMessageTimestamp(justBefore, en, NOW)).toMatch(/^Yesterday at /);
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatMessageTimestamp('not-a-date', en, NOW)).toBe('not-a-date');
  });

  it('lets each language carry the whole phrase, not a translated word plus "at"', () => {
    expect(formatMessageTimestamp(at(23), tr, NOW)).toMatch(/^Bugün \d/);
    expect(formatMessageTimestamp(at(22), tr, NOW)).toMatch(/^Dün \d/);
    expect(formatMessageTimestamp(at(23), tr, NOW)).not.toContain(' at ');
  });

  it('still reads English when no translator is supplied', () => {
    // `app/lobby/page.tsx` stamps messages during SSR and has not been
    // migrated; it must keep producing the same English it always did.
    expect(formatMessageTimestamp(at(23), undefined, NOW)).toMatch(/^Today at /);
  });
});

describe('formatDaySeparator', () => {
  it('names today and yesterday', () => {
    expect(formatDaySeparator(at(23), en, NOW)).toBe('Today');
    expect(formatDaySeparator(at(22), en, NOW)).toBe('Yesterday');
  });

  it('names them in Turkish too', () => {
    expect(formatDaySeparator(at(23), tr, NOW)).toBe('Bugün');
    expect(formatDaySeparator(at(22), tr, NOW)).toBe('Dün');
  });

  it('drops the year within the current year and keeps it outside', () => {
    expect(formatDaySeparator(at(1), en, NOW)).not.toContain('2026');
    expect(formatDaySeparator(new Date(2025, 8, 1), en, NOW)).toContain('2025');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(formatDaySeparator('nonsense', en, NOW)).toBe('');
  });
});

describe('isSameDay', () => {
  it('groups by calendar day', () => {
    expect(isSameDay(at(23, 0, 5), at(23, 23, 55))).toBe(true);
    expect(isSameDay(at(23, 23, 55), at(24, 0, 5))).toBe(false);
  });

  it('is false when either side is unparseable', () => {
    expect(isSameDay('nonsense', at(23))).toBe(false);
  });
});

describe('formatFullTimestamp', () => {
  it('spells out the whole instant for the tooltip', () => {
    const full = formatFullTimestamp(at(23));
    expect(full).toContain('2026');
    // Weekday and month names are locale-dependent; assert it is not the
    // abbreviated form the message stamp uses.
    expect(full.length).toBeGreaterThan(15);
  });

  it('returns an empty string for an unparseable value', () => {
    expect(formatFullTimestamp('nope')).toBe('');
  });
});

describe('dates are formatted in the language of the sentence around them', () => {
  /**
   * The relative phrases come from the catalogue but the month names
   * come from `Intl`, and the two used to disagree: a Turkish user on an
   * English-locale browser read "Bugün 11:34" under a separator saying
   * "23 September 2026".
   */
  const tr = createTranslator('tr');
  const en = createTranslator('en');

  it('names the month in the app language, not the browser default', () => {
    const separator = formatDaySeparator(at(1), tr, NOW);
    expect(separator).toContain('Eylül');
    expect(separator).not.toContain('September');
  });

  it('still reads English for an English reader', () => {
    expect(formatDaySeparator(at(1), en, NOW)).toContain('September');
  });

  it('spells the tooltip out in the same language', () => {
    expect(formatFullTimestamp(at(1), tr)).toContain('Eylül');
  });

  it('carries its locale on the translator rather than a separate argument', () => {
    expect(tr.locale).toBe('tr');
    expect(en.locale).toBe('en');
  });
});
