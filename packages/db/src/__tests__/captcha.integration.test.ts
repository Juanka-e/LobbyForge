/**
 * Bot protection settings (0045) against real Postgres:
 *   - a row written without the new columns (the previous image) reads the
 *     contract defaults;
 *   - the getter answers the defaults when there is no row at all;
 *   - the setter is a partial update (undefined keeps, null clears) and
 *     creates the row when it is missing;
 *   - the CHECK backstops refuse a plaintext secret, an unknown provider and
 *     non-object JSON.
 *
 * Uses its own instance ids, never the 'self-host' singleton other suites
 * read. Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  DEFAULT_CAPTCHA_SURFACES,
  getInstanceCaptchaSettings,
  setInstanceCaptchaSettings,
} from '../queries/instanceSettings.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const ENCRYPTED = 'v1.aXYtaXYtaXYtaXY.Y2lwaGVydGV4dA.dGFnLXRhZy10YWctdGFn';

describe.skipIf(!DB_URL)('bot protection settings (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);
  const legacy = `captcha-legacy-${randomUUID()}`;
  const fresh = `captcha-fresh-${randomUUID()}`;
  const missing = `captcha-missing-${randomUUID()}`;

  afterAll(async () => {
    await sql`DELETE FROM instance_settings WHERE instance_id IN (${legacy}, ${fresh}, ${missing})`;
    await sql.end();
  });

  it('a row written by the previous image reads the contract defaults', async () => {
    await sql`INSERT INTO instance_settings (instance_id, instance_name) VALUES (${legacy}, 'Legacy')`;
    const settings = await getInstanceCaptchaSettings(db, legacy);
    expect(settings).toMatchObject({
      instanceId: legacy,
      provider: 'altcha',
      surfaces: DEFAULT_CAPTCHA_SURFACES,
      siteKey: null,
      secretEncrypted: null,
      options: {},
      attackMode: false,
    });
  });

  it('answers the defaults when there is no settings row', async () => {
    const settings = await getInstanceCaptchaSettings(db, missing);
    expect(settings).toMatchObject({ provider: 'altcha', surfaces: DEFAULT_CAPTCHA_SURFACES, attackMode: false, updatedAt: null });
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM instance_settings WHERE instance_id = ${missing}`;
    expect(count).toBe(0);
  });

  it('creates the row on first save and updates only the fields given', async () => {
    const created = await setInstanceCaptchaSettings(db, {
      instanceId: fresh,
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAsite',
      secretEncrypted: ENCRYPTED,
    });
    expect(created).toMatchObject({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAsite',
      secretEncrypted: ENCRYPTED,
      surfaces: DEFAULT_CAPTCHA_SURFACES,
      options: {},
      attackMode: false,
    });

    const updated = await setInstanceCaptchaSettings(db, {
      instanceId: fresh,
      surfaces: { register: 'on', invite_register: 'on', guest: 'off', login: 'always' },
      options: { loginFailureThreshold: 5 },
      attackMode: true,
    });
    expect(updated).toMatchObject({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAsite',
      secretEncrypted: ENCRYPTED,
      surfaces: { register: 'on', invite_register: 'on', guest: 'off', login: 'always' },
      options: { loginFailureThreshold: 5 },
      attackMode: true,
    });

    const cleared = await setInstanceCaptchaSettings(db, { instanceId: fresh, provider: 'altcha', siteKey: null, secretEncrypted: null });
    expect(cleared).toMatchObject({ provider: 'altcha', siteKey: null, secretEncrypted: null, attackMode: true });
    expect(await getInstanceCaptchaSettings(db, fresh)).toEqual(cleared);
  });

  it('refuses a plaintext secret, an unknown provider and non-object JSON', async () => {
    await expect(sql`UPDATE instance_settings SET captcha_secret_encrypted = 'my-plain-secret' WHERE instance_id = ${fresh}`).rejects.toThrow(
      /instance_settings_captcha_secret_encrypted_check/
    );
    await expect(sql`UPDATE instance_settings SET captcha_provider = 'hcaptcha' WHERE instance_id = ${fresh}`).rejects.toThrow(
      /instance_settings_captcha_provider_check/
    );
    await expect(sql`UPDATE instance_settings SET captcha_surfaces = '[]'::jsonb WHERE instance_id = ${fresh}`).rejects.toThrow(
      /instance_settings_captcha_surfaces_check/
    );
    await expect(sql`UPDATE instance_settings SET captcha_options = '"x"'::jsonb WHERE instance_id = ${fresh}`).rejects.toThrow(
      /instance_settings_captcha_options_check/
    );
    await expect(sql`UPDATE instance_settings SET captcha_site_key = '' WHERE instance_id = ${fresh}`).rejects.toThrow(
      /instance_settings_captcha_site_key_check/
    );
  });
});
