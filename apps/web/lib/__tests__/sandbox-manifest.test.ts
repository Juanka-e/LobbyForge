/**
 * The installer's sandbox-v1 manifest validator (lib/sandbox-manifest.ts)
 * against the case table shared with the plugin worker's twin
 * (apps/plugin-worker/src/manifest.ts): installer and worker must agree on
 * every case.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSandboxManifest, validateSandboxManifest } from '../sandbox-manifest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');

interface Case {
  name: string;
  patch?: Record<string, unknown>;
  manifest?: unknown;
  json?: string;
}
const table = JSON.parse(
  readFileSync(join(REPO_ROOT, 'apps', 'plugin-worker', 'src', '__tests__', 'fixtures', 'manifest-cases.json'), 'utf8')
) as { base: Record<string, unknown>; valid: Case[]; invalid: Case[] };

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

describe('validateSandboxManifest (installer) — shared case table', () => {
  for (const c of table.valid) {
    it(`accepts: ${c.name}`, () => {
      const result = validateSandboxManifest(build(c));
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
    });
  }
  for (const c of table.invalid) {
    it(`refuses: ${c.name}`, () => {
      expect(validateSandboxManifest(build(c)).ok).toBe(false);
    });
  }

  it('is the same code as the worker validator (twin files stay in step)', () => {
    const body = (path: string) =>
      readFileSync(path, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
    expect(body(join(REPO_ROOT, 'apps', 'web', 'lib', 'sandbox-manifest.ts'))).toBe(
      body(join(REPO_ROOT, 'apps', 'plugin-worker', 'src', 'manifest.ts'))
    );
  });

  it('accepts the example plugin manifest', () => {
    const parsed = parseSandboxManifest(readFileSync(join(REPO_ROOT, 'examples', 'plugins', 'sandbox-buzzer', 'manifest.json')));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  });
});
