/**
 * ADR-007: marketplace (sandbox-v1) plugins project their own state in the
 * plugin worker. Core has no rule for them, so a caller that cannot reach
 * the worker (the ws-gateway) must never serve their state through
 * projectActivityState — it routes on isCoreProjectedPlugin and asks the
 * web app. And the signed internal request the gateway uses for that.
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_PROJECTED_PLUGIN_IDS,
  isCoreProjectedPlugin,
  projectActivityState,
} from '../activity-projection.js';
import {
  INTERNAL_SIGNATURE_MAX_SKEW_SECONDS,
  signInternalRequest,
  verifyInternalRequest,
} from '../internal-signature.js';

describe('isCoreProjectedPlugin — which states core may project alone', () => {
  it('covers exactly the official compiled-in plugins', () => {
    expect([...CORE_PROJECTED_PLUGIN_IDS].sort()).toEqual(
      ['dice-bot', 'hushle', 'poll', 'quiz', 'vampire-village', 'watch-party'].sort()
    );
    for (const id of CORE_PROJECTED_PLUGIN_IDS) expect(isCoreProjectedPlugin(id)).toBe(true);
  });

  it('a marketplace plugin id is never core-projected (exact match only)', () => {
    for (const id of ['sandbox-buzzer', 'Hushle', 'hushle ', 'quiz2', '', '__proto__', 'constructor']) {
      expect(isCoreProjectedPlugin(id), id).toBe(false);
    }
  });

  it('why the routing matters: core returns a marketplace plugin state unfiltered', () => {
    // A secret a sandbox plugin hides in its own projectState. Core knows
    // nothing about it — serving this would leak it to every viewer.
    const state = { phase: 'open', buzzes: [{ playerId: 'u-alice', at: 1 }] };
    const out = projectActivityState(state, 'sandbox-buzzer', 'u-bob') as typeof state;
    expect(out.buzzes).toEqual(state.buzzes);
    expect(isCoreProjectedPlugin('sandbox-buzzer')).toBe(false);
  });
});

describe('internal request signatures', () => {
  const SECRET = 's'.repeat(40);
  const BODY = JSON.stringify({ serverId: 'srv', sessionId: 'sess', viewerUserId: 'u1' });
  const NOW = 1_800_000_000_000;

  it('round-trips for the same purpose, body and time window', () => {
    const header = signInternalRequest(SECRET, 'activity-projection', BODY, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyInternalRequest(SECRET, 'activity-projection', header, BODY, NOW)).toBe(true);
    expect(verifyInternalRequest(SECRET, 'activity-projection', header, BODY, NOW + 30_000)).toBe(true);
  });

  it('refuses another body, purpose, secret, a stale or future timestamp, and junk', () => {
    const header = signInternalRequest(SECRET, 'activity-projection', BODY, NOW);
    expect(verifyInternalRequest(SECRET, 'activity-projection', header, BODY.replace('u1', 'u2'), NOW)).toBe(false);
    expect(verifyInternalRequest(SECRET, 'other-purpose', header, BODY, NOW)).toBe(false);
    expect(verifyInternalRequest('t'.repeat(40), 'activity-projection', header, BODY, NOW)).toBe(false);
    const skew = (INTERNAL_SIGNATURE_MAX_SKEW_SECONDS + 5) * 1000;
    expect(verifyInternalRequest(SECRET, 'activity-projection', header, BODY, NOW + skew)).toBe(false);
    expect(verifyInternalRequest(SECRET, 'activity-projection', header, BODY, NOW - skew)).toBe(false);
    for (const junk of [null, '', 't=1,v1=zz', `t=abc,v1=${'0'.repeat(64)}`, header.toUpperCase()]) {
      expect(verifyInternalRequest(SECRET, 'activity-projection', junk, BODY, NOW)).toBe(false);
    }
  });

  it('never verifies with a missing or short secret, and refuses to sign with one', () => {
    const header = signInternalRequest(SECRET, 'activity-projection', BODY, NOW);
    expect(verifyInternalRequest(undefined, 'activity-projection', header, BODY, NOW)).toBe(false);
    expect(verifyInternalRequest('short', 'activity-projection', header, BODY, NOW)).toBe(false);
    expect(() => signInternalRequest('short', 'activity-projection', BODY, NOW)).toThrow();
  });
});
