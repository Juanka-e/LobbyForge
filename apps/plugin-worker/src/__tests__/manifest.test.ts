/**
 * The sandbox-v1 manifest validator (manifest.ts). The case table is shared
 * with the web installer's twin (apps/web/lib/sandbox-manifest.ts), so the
 * worker and the installer can never disagree on what a valid manifest is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES, parseSandboxManifest, validateSandboxManifest } from '../manifest.js';

interface Case {
  name: string;
  patch?: Record<string, unknown>;
  manifest?: unknown;
  json?: string;
}
const table = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'manifest-cases.json'), 'utf8')) as {
  base: Record<string, unknown>;
  valid: Case[];
  invalid: Case[];
};

/** `null` in a patch removes the key. */
function build(c: Case): unknown {
  if (c.json !== undefined) return JSON.parse(c.json);
  if (c.manifest !== undefined) return c.manifest;
  const out: Record<string, unknown> = structuredClone(table.base);
  for (const [key, value] of Object.entries(c.patch ?? {})) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

describe('validateSandboxManifest — shared case table', () => {
  for (const c of table.valid) {
    it(`accepts: ${c.name}`, () => {
      const result = validateSandboxManifest(build(c));
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
    });
  }
  for (const c of table.invalid) {
    it(`refuses: ${c.name}`, () => {
      const result = validateSandboxManifest(build(c));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^manifest\.json: /);
    });
  }
});

describe('validateSandboxManifest — the normalised result', () => {
  it('keeps only known policy fields and defaults locales to en', () => {
    const result = validateSandboxManifest(build({ name: 'base' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual({
      id: 'case-game',
      name: 'Case Game',
      version: '1.2.3',
      sdk: 'sandbox-v1',
      ui: false,
      locales: ['en'],
      actionPolicies: {
        start: { role: 'host' },
        join: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
        move: { role: 'player', actorFields: ['playerId'], audit: false },
      },
    });
    // A plain object: the host indexes it with Object.hasOwn.
    expect(Object.getPrototypeOf(result.manifest.actionPolicies)).toBe(Object.prototype);
  });

  it('names the legacy-bundle fix when sdk is missing', () => {
    const result = validateSandboxManifest(build({ name: 'legacy', patch: { sdk: null } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('legacy Node bundles');
  });
});

describe('parseSandboxManifest', () => {
  it('refuses invalid JSON and oversized files', () => {
    expect(parseSandboxManifest('{not json')).toMatchObject({ ok: false, error: 'manifest.json: not valid JSON' });
    const huge = JSON.stringify({ ...table.base, pad: 'x'.repeat(MAX_MANIFEST_BYTES) });
    expect(parseSandboxManifest(huge).ok).toBe(false);
  });

  it('accepts the example plugin manifest', () => {
    const bytes = readFileSync(join(__dirname, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer', 'manifest.json'));
    const result = parseSandboxManifest(bytes);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (result.ok) {
      expect(result.manifest.actionPolicies.buzz).toEqual({ role: 'member', actorFields: ['playerId'], joinsRoster: true });
    }
  });
});
