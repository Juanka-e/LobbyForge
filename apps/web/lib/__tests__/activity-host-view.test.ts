import { describe, expect, it } from 'vitest';
import { HOST_CHECK_MARGIN_MS, nextHostCheck, parseActivityHost, type ActivityHostState } from '../activity-host-view';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function away(overrides: Partial<ActivityHostState> = {}): ActivityHostState {
  return {
    userId: 'u-host',
    inVoice: false,
    awaySince: at(-30_000),
    transferAt: at(30_000),
    abandonAt: at(150_000),
    abandoned: false,
    ...overrides,
  };
}

describe('parseActivityHost', () => {
  it('reads the GET body’s host and drops junk', () => {
    expect(parseActivityHost({ userId: 'u1', inVoice: false, awaySince: at(0), transferAt: at(1), abandonAt: 'nope', abandoned: 'yes' })).toEqual({
      userId: 'u1',
      inVoice: false,
      awaySince: at(0),
      transferAt: at(1),
      abandonAt: null,
      abandoned: false,
    });
    expect(parseActivityHost(undefined)).toBeNull();
    expect(parseActivityHost(['x'])).toBeNull();
  });
});

describe('nextHostCheck', () => {
  it('waits for nothing while the host is in the room, or without a host view', () => {
    expect(nextHostCheck(null, NOW)).toBeNull();
    expect(nextHostCheck(away({ inVoice: true }), NOW)).toBeNull();
  });

  it('re-reads just after the transfer is due', () => {
    expect(nextHostCheck(away(), NOW)).toEqual({ at: NOW + 30_000, delay: 30_000 + HOST_CHECK_MARGIN_MS });
  });

  it('re-reads at abandonment when nobody can take over', () => {
    expect(nextHostCheck(away({ transferAt: null, abandonAt: at(30_000) }), NOW)).toEqual({
      at: NOW + 30_000,
      delay: 30_000 + HOST_CHECK_MARGIN_MS,
    });
  });

  it('re-reads at once for a due time already passed — and then backs off for the same time instead of looping', () => {
    const host = away({ transferAt: at(-1_000) });
    expect(nextHostCheck(host, NOW)).toEqual({ at: NOW - 1_000, delay: HOST_CHECK_MARGIN_MS });
    // The server could not hand over yet: the next re-read for it waits 2 s, then 4 s …
    expect(nextHostCheck(host, NOW, new Map([[NOW - 1_000, 1]]))).toEqual({ at: NOW - 1_000, delay: 2_000 + HOST_CHECK_MARGIN_MS });
    expect(nextHostCheck(host, NOW, new Map([[NOW - 1_000, 3]]))).toEqual({ at: NOW - 1_000, delay: 8_000 + HOST_CHECK_MARGIN_MS });
    // … and abandonment, when it comes first, wins.
    expect(nextHostCheck(host, NOW + 149_000, new Map([[NOW - 1_000, 9]]))).toEqual({
      at: NOW + 150_000,
      delay: 1_000 + HOST_CHECK_MARGIN_MS,
    });
  });

  it('stops once the session is abandoned and nothing else is due', () => {
    expect(nextHostCheck(away({ transferAt: null, abandonAt: at(-5_000), abandoned: true }), NOW)).toBeNull();
  });
});
