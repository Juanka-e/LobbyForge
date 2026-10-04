/**
 * 0045_captcha — the migration file, journal and snapshot, read from disk
 * (no database). The SQL itself runs in captcha.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceSettings } from '../schema.js';
import { DEFAULT_CAPTCHA_SURFACES } from '../queries/instanceSettings.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0045_captcha.sql'), 'utf8');
const COLUMNS = [
  'captcha_provider',
  'captcha_surfaces',
  'captcha_site_key',
  'captcha_secret_encrypted',
  'captcha_options',
  'captcha_attack_mode',
];

describe('0045_captcha', () => {
  it('is expand-only and idempotent: six added columns on instance_settings, nothing else', () => {
    expect(sql.match(/ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS/g)).toHaveLength(6);
    for (const column of COLUMNS) {
      expect(sql).toContain(`ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    expect(sql).not.toMatch(/CREATE TABLE|DROP |DELETE FROM|^UPDATE |ALTER COLUMN|RENAME/m);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(6);
  });

  it('defaults to the built-in provider with sign-up and new guests protected and adaptive sign-in', () => {
    expect(sql).toContain(`"captcha_provider" text DEFAULT 'altcha' NOT NULL`);
    expect(sql).toContain(
      `"captcha_surfaces" jsonb DEFAULT '{"register":"on","invite_register":"off","guest":"on","login":"adaptive"}'::jsonb NOT NULL`
    );
    expect(sql).toContain(`"captcha_options" jsonb DEFAULT '{}'::jsonb NOT NULL`);
    expect(sql).toContain('"captcha_attack_mode" boolean DEFAULT false NOT NULL');
    // The SQL default and the query helper's no-row default are the same object.
    expect(JSON.parse(/"captcha_surfaces" jsonb DEFAULT '([^']+)'/.exec(sql)![1]!)).toEqual(DEFAULT_CAPTCHA_SURFACES);
  });

  it('keeps a plaintext secret out of the table (CHECK backstops)', () => {
    expect(sql).toContain(`CHECK ("captcha_provider" IN ('none', 'altcha', 'turnstile', 'recaptcha'))`);
    expect(sql).toContain(`CHECK ("captcha_secret_encrypted" IS NULL OR "captcha_secret_encrypted" ~ '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$')`);
    expect(sql).toContain(`CHECK (jsonb_typeof("captcha_surfaces") = 'object')`);
    expect(sql).toContain(`CHECK (jsonb_typeof("captcha_options") = 'object')`);
    expect(sql).toContain('CHECK ("captcha_site_key" IS NULL OR char_length("captcha_site_key") BETWEEN 1 AND 256)');
  });

  it('splits into single statements the migrator can run one by one', () => {
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(6);
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('matches the Drizzle schema', () => {
    expect(instanceSettings.captchaProvider.default).toBe('altcha');
    expect(instanceSettings.captchaProvider.notNull).toBe(true);
    expect(instanceSettings.captchaSurfaces.default).toEqual(DEFAULT_CAPTCHA_SURFACES);
    expect(instanceSettings.captchaSiteKey.notNull).toBe(false);
    expect(instanceSettings.captchaSecretEncrypted.notNull).toBe(false);
    expect(instanceSettings.captchaOptions.default).toEqual({});
    expect(instanceSettings.captchaAttackMode.default).toBe(false);
    expect(instanceSettings.captchaAttackMode.notNull).toBe(true);
  });

  it('is journal entry 43 and its snapshot chains from 0044 with only the six columns added', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0045_captcha');
    expect(entry?.idx).toBe(43);
    const prevEntry = journal.entries.find((e) => e.tag === '0044_bot_api_v2');
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: unknown }> }>;
    };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0044_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0045_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    for (const [key, value] of Object.entries(prev.tables)) {
      if (key === 'public.instance_settings') continue;
      expect(snapshot.tables[key]).toEqual(value);
    }
    const before = prev.tables['public.instance_settings']!;
    const after = snapshot.tables['public.instance_settings']!;
    expect({
      ...after,
      columns: Object.fromEntries(Object.entries(after.columns).filter(([k]) => !COLUMNS.includes(k))),
    }).toEqual(before);
    expect(Object.keys(after.columns).filter((k) => COLUMNS.includes(k))).toEqual(COLUMNS);
    expect(after.columns.captcha_provider).toMatchObject({ type: 'text', notNull: true, default: "'altcha'" });
    expect(after.columns.captcha_surfaces).toMatchObject({ type: 'jsonb', notNull: true });
    expect(after.columns.captcha_site_key).toMatchObject({ type: 'text', notNull: false });
    expect(after.columns.captcha_secret_encrypted).toMatchObject({ type: 'text', notNull: false });
    expect(after.columns.captcha_options).toMatchObject({ type: 'jsonb', notNull: true, default: "'{}'::jsonb" });
    expect(after.columns.captcha_attack_mode).toMatchObject({ type: 'boolean', notNull: true, default: false });
  });
});
