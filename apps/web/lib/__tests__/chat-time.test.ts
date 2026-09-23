import { describe, expect, it } from 'vitest';
import {
  formatDaySeparator,
  formatFullTimestamp,
  formatMessageTimestamp,
  isSameDay,
} from '../chat-time.js';

/**
 * Relative dates are the kind of thing that silently drifts: an
 * off-by-one in the day maths only shows up as "Yesterday" on a message
 * sent this morning, which nobody reports as a bug. The boundaries are
 * pinned here against a fixed `now`.
 */
const NOW = new Date(2026, 8, 23, 14, 30); // 23 Sep 2026, 14:30 local

const at = (day: number, hour = 11, minute = 34) => new Date(2026, 8, day, hour, minute);

describe('formatMessageTimestamp', () => {
  it('reads relatively for today', () => {
    expect(formatMessageTimestamp(at(23), NOW)).toMatch(/^Today at /);
  });

  it('reads relatively for yesterday', () => {
    expect(formatMessageTimestamp(at(22), NOW)).toMatch(/^Yesterday at /);
  });

  it('falls back to an absolute date once older', () => {
    const stamp = formatMessageTimestamp(at(21), NOW);
    expect(stamp).not.toMatch(/Today|Yesterday/);
    expect(stamp).toContain('2026');
  });

  it('counts calendar days, not elapsed hours', () => {
    // 00:10 today vs 23:50 yesterday is 20 minutes apart, but they are
    // different days and must read that way.
    const justAfterMidnight = new Date(2026, 8, 23, 0, 10);
    const justBefore = new Date(2026, 8, 22, 23, 50);
    expect(formatMessageTimestamp(justAfterMidnight, NOW)).toMatch(/^Today at /);
    expect(formatMessageTimestamp(justBefore, NOW)).toMatch(/^Yesterday at /);
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatMessageTimestamp('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatDaySeparator', () => {
  it('names today and yesterday', () => {
    expect(formatDaySeparator(at(23), NOW)).toBe('Today');
    expect(formatDaySeparator(at(22), NOW)).toBe('Yesterday');
  });

  it('drops the year within the current year and keeps it outside', () => {
    expect(formatDaySeparator(at(1), NOW)).not.toContain('2026');
    expect(formatDaySeparator(new Date(2025, 8, 1), NOW)).toContain('2025');
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
