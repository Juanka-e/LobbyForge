/**
 * What a marketplace plugin asks for beyond the sandbox, and what the owner
 * approved (plugin-approvals.ts, docs/PLUGIN_UNLOCK_PLAN.md).
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveApprovals,
  needsApproval,
  newApprovals,
  parseApprovals,
  requestedApprovals,
  sameApprovals,
  sandboxManifestOptions,
} from '../plugin-approvals';
import { validateSandboxManifest, type SandboxManifest } from '../sandbox-manifest';

function manifest(extra: Record<string, unknown> = {}): SandboxManifest {
  const result = validateSandboxManifest({
    id: 'game',
    name: 'Game',
    version: '1.0.0',
    sdk: 'sandbox-v1',
    ui: false,
    actionPolicies: {},
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result.manifest;
}

const ASKS = manifest({
  ui: { url: 'https://game.example.com/play' },
  network: { connect: ['https://api.example.com', 'https://b.example.com'], img: ['https://cdn.example.com'] },
  permissions: ['timers', 'chat'],
});

describe('requestedApprovals', () => {
  it('is null for a plugin that asks for nothing beyond the sandbox', () => {
    expect(requestedApprovals(manifest())).toBeNull();
    expect(requestedApprovals(manifest({ network: {}, permissions: [] }))).toBeNull();
  });

  it('names every origin, the UI site and the permissions, sorted', () => {
    expect(requestedApprovals(ASKS)).toEqual({
      network: { connect: ['https://api.example.com', 'https://b.example.com'], img: ['https://cdn.example.com'] },
      uiUrl: 'https://game.example.com/play',
      permissions: ['chat', 'timers'],
    });
  });

  it('the manifest normalizes what it names (a trailing slash, letter case)', () => {
    const m = manifest({ network: { connect: ['HTTPS://API.Example.com/'] } });
    expect(requestedApprovals(m)).toEqual({ network: { connect: ['https://api.example.com'] } });
  });
});

describe('sameApprovals — an approval must name the request exactly', () => {
  const requested = requestedApprovals(ASKS)!;

  it('ignores order and duplicates', () => {
    expect(
      sameApprovals(requested, {
        permissions: ['timers', 'chat', 'chat'],
        network: { img: ['https://cdn.example.com'], connect: ['https://b.example.com', 'https://api.example.com'] },
        uiUrl: 'https://game.example.com/play',
      })
    ).toBe(true);
  });

  it('refuses less, more, or a different site', () => {
    expect(sameApprovals(requested, { ...requested, permissions: ['timers'] })).toBe(false);
    expect(sameApprovals(requested, { ...requested, permissions: ['chat', 'timers', 'storage'] })).toBe(false);
    expect(sameApprovals(requested, { ...requested, uiUrl: 'https://game.example.com/other' })).toBe(false);
    expect(sameApprovals(requested, null)).toBe(false);
    expect(sameApprovals(null, null)).toBe(true);
  });
});

describe('newApprovals — what an upgrade asks about', () => {
  it('is everything on a first install', () => {
    expect(newApprovals(null, requestedApprovals(ASKS))).toEqual(requestedApprovals(ASKS));
  });

  it('is only what the active version had not approved', () => {
    const before = { network: { connect: ['https://api.example.com'] }, permissions: ['timers' as const] };
    expect(newApprovals(before, requestedApprovals(ASKS))).toEqual({
      network: { connect: ['https://b.example.com'], img: ['https://cdn.example.com'] },
      uiUrl: 'https://game.example.com/play',
      permissions: ['chat'],
    });
    expect(newApprovals(requestedApprovals(ASKS), requestedApprovals(ASKS))).toBeNull();
    expect(newApprovals(before, null)).toBeNull();
  });
});

describe('effectiveApprovals — what a plugin may actually use', () => {
  it('is the request, as far as it was approved', () => {
    const approved = { network: { connect: ['https://api.example.com', 'https://other.example.com'] }, permissions: ['chat' as const] };
    expect(effectiveApprovals(ASKS, approved)).toEqual({
      network: { connect: ['https://api.example.com'] },
      permissions: ['chat'],
    });
  });

  it('grants nothing to a bundle that was never approved (installed before approvals existed)', () => {
    expect(effectiveApprovals(ASKS, undefined)).toEqual({});
    expect(needsApproval(ASKS, undefined)).toBe(true);
    expect(needsApproval(ASKS, requestedApprovals(ASKS))).toBe(false);
    expect(needsApproval(manifest(), undefined)).toBe(false);
  });
});

describe('parseApprovals', () => {
  it('reads an approval with the manifest’s own rules', () => {
    expect(
      parseApprovals({
        network: { connect: ['https://api.example.com/'] },
        uiUrl: 'https://game.example.com/play',
        permissions: ['timers'],
      })
    ).toEqual({ network: { connect: ['https://api.example.com'] }, uiUrl: 'https://game.example.com/play', permissions: ['timers'] });
    expect(parseApprovals(undefined)).toBeNull();
    expect(parseApprovals(null)).toBeNull();
  });

  it.each([
    ['an array', []],
    ['an unknown key', { network: {}, extra: true }],
    ['an unknown network kind', { network: { script: ['https://a.example.com'] } }],
    ['a local origin', { network: { connect: ['https://localhost'] } }],
    ['an http origin', { network: { connect: ['http://api.example.com'] } }],
    ['a javascript: UI', { uiUrl: 'javascript:alert(1)' }],
    ['an unknown permission', { permissions: ['root'] }],
  ])('approves nothing for %s', (_label, value) => {
    expect(parseApprovals(value)).toBeNull();
  });

  it('allows local origins only when told to, and never in production', () => {
    const local = { network: { connect: ['http://localhost:4000'] } };
    expect(parseApprovals(local)).toBeNull();
    expect(parseApprovals(local, { allowLocalOrigins: true })).toEqual({ network: { connect: ['http://localhost:4000'] } });
    expect(sandboxManifestOptions({ LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS: 'true', NODE_ENV: 'development' })).toEqual({ allowLocalOrigins: true });
    expect(sandboxManifestOptions({ LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS: 'true', NODE_ENV: 'production' })).toEqual({ allowLocalOrigins: false });
    expect(sandboxManifestOptions({})).toEqual({ allowLocalOrigins: false });
  });
});
