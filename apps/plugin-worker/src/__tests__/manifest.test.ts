/**
 * The sandbox-v1 manifest validator (manifest.ts). The case table is shared
 * with the web installer's twin (apps/web/lib/sandbox-manifest.ts), so the
 * worker and the installer can never disagree on what a valid manifest is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES, parseSandboxBundle, parseSandboxManifest, validateSandboxManifest } from '../manifest.js';

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

// ── Bundles: manifest.json + locales/<code>.json ─────────────────────────

interface BundleCase {
  name: string;
  patch?: Record<string, unknown>;
  files?: Record<string, unknown>;
  raw?: Record<string, string>;
  fill?: { file?: string; files?: string[]; key?: string; keys: number; chars: number };
  manyFiles?: number;
  locales?: string[];
}
const bundles = (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'manifest-cases.json'), 'utf8')) as {
  bundles: { valid: BundleCase[]; invalid: BundleCase[] };
}).bundles;

/** `aa`, `ab`, … — valid two-letter codes for the generated files. */
const generatedCode = (i: number) => String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));

function buildBundle(c: BundleCase): { manifest: string; files: Array<[string, string]> } {
  const files: Array<[string, string]> = [];
  for (const [path, table] of Object.entries(c.files ?? {})) files.push([path, JSON.stringify(table)]);
  for (const [path, text] of Object.entries(c.raw ?? {})) files.push([path, text]);
  if (c.fill) {
    for (const path of c.fill.files ?? [c.fill.file!]) {
      const table: Record<string, string> = {};
      for (let i = 0; i < c.fill.keys; i++) table[c.fill.key ?? `k${i}`] = 'x'.repeat(c.fill.chars);
      files.push([path, JSON.stringify(table)]);
    }
  }
  for (let i = 0; i < (c.manyFiles ?? 0); i++) {
    files.push([`${generatedCode(i)}.json`, JSON.stringify({ 'catalog.name': `Name ${i}` })]);
  }
  return { manifest: JSON.stringify(build({ name: c.name, patch: c.patch })), files };
}

describe('parseSandboxBundle — shared case table (locales/<code>.json)', () => {
  for (const c of bundles.valid) {
    it(`accepts: ${c.name}`, () => {
      const { manifest, files } = buildBundle(c);
      const result = parseSandboxBundle(manifest, files);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      if (!result.ok) return;
      const expected = c.locales ?? Array.from({ length: c.manyFiles ?? 0 }, (_, i) => generatedCode(i));
      expect(result.manifest.locales).toEqual(expected);
      expect(Object.keys(result.localeTables)).toEqual(files.length > 0 ? expected : []);
    });
  }
  for (const c of bundles.invalid) {
    it(`refuses: ${c.name}`, () => {
      const { manifest, files } = buildBundle(c);
      const result = parseSandboxBundle(manifest, files);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^(manifest\.json|locales\/)/);
    });
  }
});

describe('parseSandboxBundle — the tables it returns', () => {
  it('keeps every string of each language, keyed by the file’s code', () => {
    const result = parseSandboxBundle(JSON.stringify(table.base), [
      ['tr.json', JSON.stringify({ 'catalog.name': 'Zil', 'round.open': 'Tur aç' })],
      ['en.json', JSON.stringify({ 'catalog.name': 'Buzzer' })],
    ]);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.localeTables).toEqual({
      en: { 'catalog.name': 'Buzzer' },
      tr: { 'catalog.name': 'Zil', 'round.open': 'Tur aç' },
    });
  });

  it('names the file and the problem', () => {
    const result = parseSandboxBundle(JSON.stringify(table.base), [['tr.json', JSON.stringify({ 'catalog.name': 7 })]]);
    expect(result).toEqual({
      ok: false,
      error: 'locales/tr.json: "catalog.name" must be a string (the file is flat: one "key": "text" pair per string)',
    });
    const mismatch = parseSandboxBundle(JSON.stringify({ ...table.base, locales: ['en', 'de'] }), [['en.json', '{}']]);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain('no locales/de.json');
  });

  it('accepts the example plugin bundle with its English and Turkish tables', () => {
    const example = join(__dirname, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer');
    const localeFiles = readdirSync(join(example, 'locales')).map(
      (name) => [name, readFileSync(join(example, 'locales', name))] as [string, Buffer]
    );
    const result = parseSandboxBundle(readFileSync(join(example, 'manifest.json')), localeFiles);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.locales).toEqual(['en', 'tr']);
    expect(result.localeTables.tr?.['catalog.name']).toBe('Buzzer');
    expect(result.localeTables.tr?.['catalog.summary']).toMatch(/\S/);
    expect(result.localeTables.tr?.['catalog.summary']).not.toBe(result.localeTables.en?.['catalog.summary']);
  });
});
