/**
 * Languages (0048) against real Postgres:
 *   - the backfill, replayed on a throwaway copy of the pre-0048 column in
 *     its own schema (the real users table is never locked or altered):
 *     every 'en' becomes NULL, other codes stay, the column ends nullable
 *     with no default, and a re-run never clears an English choice made
 *     after the first run;
 *   - the account language: read, set, cleared; a deleted account reads
 *     as unset and cannot be written; new guests start unset;
 *   - the instance default: unset without a row, saved, cleared, with the
 *     value before and after for the audit log;
 *   - setup saves the wizard's language as the default and the owner's.
 *
 * Uses its own users and instance ids, never the 'self-host' singleton other
 * suites read. Skipped unless TEST_DATABASE_URL points at a migrated
 * scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb } from '../client.js';
import { instanceSettings, servers, users } from '../schema.js';
import {
  completeInitialBootstrap,
  getInstanceDefaultLocaleSetting,
  setInstanceDefaultLocale,
} from '../queries/instanceSettings.js';
import { findOrCreateGuestUser, getUserLocale, setUserLocale } from '../queries/users.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('account language and instance default (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 4 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);
  const userIds: string[] = [];
  const instanceIds: string[] = [];

  async function createUser(locale: string | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (display_name, locale) VALUES ('Language Test', ${locale}) RETURNING id`;
    userIds.push(row!.id);
    return row!.id;
  }

  afterAll(async () => {
    if (userIds.length) {
      await sql`DELETE FROM servers WHERE owner_user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM instance_settings WHERE owner_user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (instanceIds.length) await sql`DELETE FROM instance_settings WHERE instance_id IN ${sql(instanceIds)}`;
    await sql.end();
  });

  describe('the 0048 backfill', () => {
    const block = readFileSync(join(__dirname, '..', '..', 'drizzle', '0048_account_language.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .find((statement) => statement.startsWith('DO $$'))!;

    it('clears every never-written "en", keeps real choices, and is safe to re-run', async () => {
      const schema = `lf_0048_${randomUUID().slice(0, 8)}`;
      const conn = await sql.reserve();
      try {
        await conn.unsafe(`CREATE SCHEMA "${schema}"`);
        await conn.unsafe(`SET search_path TO "${schema}"`);
        // The column as it was before 0048.
        await conn.unsafe(`CREATE TABLE "users" ("id" serial PRIMARY KEY, "locale" text DEFAULT 'en' NOT NULL)`);
        await conn.unsafe(`INSERT INTO "users" ("locale") VALUES (DEFAULT), ('en'), ('tr'), ('pt-BR')`);

        await conn.unsafe(block);
        const after = await conn.unsafe<{ id: number; locale: string | null }[]>(`SELECT id, locale FROM "users" ORDER BY id`);
        expect(after.map((row) => row.locale)).toEqual([null, null, 'tr', 'pt-BR']);
        const [column] = await conn.unsafe<{ is_nullable: string; column_default: string | null }[]>(
          `SELECT is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = '${schema}' AND table_name = 'users' AND column_name = 'locale'`
        );
        expect(column).toEqual({ is_nullable: 'YES', column_default: null });

        // After the first run, 'en' is an explicit choice; a re-run keeps it.
        await conn.unsafe(`UPDATE "users" SET "locale" = 'en' WHERE id = 1`);
        await conn.unsafe(`INSERT INTO "users" DEFAULT VALUES`);
        await conn.unsafe(block);
        const rerun = await conn.unsafe<{ locale: string | null }[]>(`SELECT locale FROM "users" ORDER BY id`);
        expect(rerun.map((row) => row.locale)).toEqual(['en', null, 'tr', 'pt-BR', null]);
      } finally {
        await conn.unsafe(`RESET search_path`);
        await conn.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        conn.release();
      }
    });

    it('left the real users.locale nullable with no default', async () => {
      const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'locale'`;
      expect(column).toEqual({ is_nullable: 'YES', column_default: null });
      const [settings] = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'instance_settings' AND column_name = 'default_locale'`;
      expect(settings?.is_nullable).toBe('YES');
    });
  });

  describe('the account language', () => {
    it('starts unset, and is saved, changed and cleared', async () => {
      const id = await createUser();
      expect(await getUserLocale(db, id)).toBeNull();
      expect(await setUserLocale(db, id, 'tr')).toBe('tr');
      expect(await getUserLocale(db, id)).toBe('tr');
      // An explicit English choice is stored as such.
      expect(await setUserLocale(db, id, 'en')).toBe('en');
      expect(await getUserLocale(db, id)).toBe('en');
      expect(await setUserLocale(db, id, null)).toBeNull();
      expect(await getUserLocale(db, id)).toBeNull();
    });

    it('reads a deleted or missing account as unset, and does not write it', async () => {
      const id = await createUser('tr');
      await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
      expect(await getUserLocale(db, id)).toBeNull();
      expect(await setUserLocale(db, id, 'en')).toBeUndefined();
      expect((await sql<{ locale: string }[]>`SELECT locale FROM users WHERE id = ${id}`)[0]!.locale).toBe('tr');
      expect(await getUserLocale(db, randomUUID())).toBeNull();
      expect(await setUserLocale(db, randomUUID(), 'tr')).toBeUndefined();
    });

    it('a new guest follows its browser until it picks a language', async () => {
      const guest = await findOrCreateGuestUser(db, { guestKey: `g_${randomUUID().replace(/-/g, '')}`, displayName: 'Guest' });
      userIds.push(guest!.id);
      expect(guest!.locale).toBeNull();
      expect(await getUserLocale(db, guest!.id)).toBeNull();
    });
  });

  describe('the instance default', () => {
    it('is unset without a row; saved, changed and cleared with the value before and after', async () => {
      const instanceId = `lang-${randomUUID()}`;
      instanceIds.push(instanceId);
      expect(await getInstanceDefaultLocaleSetting(db, instanceId)).toBeNull();
      expect(await setInstanceDefaultLocale(db, 'tr', instanceId)).toEqual({ previous: null, current: 'tr' });
      expect(await getInstanceDefaultLocaleSetting(db, instanceId)).toBe('tr');
      expect(await setInstanceDefaultLocale(db, 'en', instanceId)).toEqual({ previous: 'tr', current: 'en' });
      expect(await setInstanceDefaultLocale(db, null, instanceId)).toEqual({ previous: 'en', current: null });
      expect(await getInstanceDefaultLocaleSetting(db, instanceId)).toBeNull();
    });
  });

  describe('setup', () => {
    it('saves the wizard’s language as the instance default and as the owner’s language', async () => {
      const instanceId = `lang-setup-${randomUUID()}`;
      instanceIds.push(instanceId);
      const result = await completeInitialBootstrap(db, {
        instanceId,
        instanceName: 'Dil Topluluğu',
        ownerDisplayName: 'Kurucu',
        ownerEmail: `lang-owner-${randomUUID()}@example.invalid`,
        ownerPasswordHash: '$test$not-a-real-password-hash',
        registrationMode: 'invite_only',
        guestAccessEnabled: false,
        seoIndexingEnabled: false,
        defaultLocale: 'tr',
        ownerLocale: 'tr',
      });
      userIds.push(result.owner.id);
      expect(await getInstanceDefaultLocaleSetting(db, instanceId)).toBe('tr');
      expect(await getUserLocale(db, result.owner.id)).toBe('tr');
      const [server] = await db.select({ id: servers.id }).from(servers).where(eq(servers.ownerUserId, result.owner.id));
      expect(server).toBeDefined();
      const [row] = await db.select({ defaultLocale: instanceSettings.defaultLocale }).from(instanceSettings).where(eq(instanceSettings.instanceId, instanceId));
      expect(row?.defaultLocale).toBe('tr');
    });

    it('leaves both unset when the wizard sent no language', async () => {
      const instanceId = `lang-setup-${randomUUID()}`;
      instanceIds.push(instanceId);
      const result = await completeInitialBootstrap(db, {
        instanceId,
        instanceName: 'No Language',
        ownerDisplayName: 'Founder',
        ownerEmail: `lang-owner-${randomUUID()}@example.invalid`,
        ownerPasswordHash: '$test$not-a-real-password-hash',
        registrationMode: 'invite_only',
        guestAccessEnabled: false,
        seoIndexingEnabled: false,
      });
      userIds.push(result.owner.id);
      expect(await getInstanceDefaultLocaleSetting(db, instanceId)).toBeNull();
      const [owner] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, result.owner.id));
      expect(owner?.locale).toBeNull();
    });
  });
});
