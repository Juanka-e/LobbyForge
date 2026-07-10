import { describe, it, expect } from 'vitest';
import { createDb } from '../client.js';
import { eq, sql } from 'drizzle-orm';
import { instanceSettings, servers, users } from '../schema.js';
import {
  completeInitialBootstrap,
  getInstanceBootstrapStatus,
  SetupAlreadyCompleteError,
} from '../queries/instanceSettings.js';

describe('Database Integrations', () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    it.skip('Skipping integration tests (TEST_DATABASE_URL is missing)', () => {});
    return;
  }

  it('connects to the database', async () => {
    const db = createDb(url);
    const tables = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const names = tables.map((t) => String(t.table_name));
    // After running `pnpm -F @lobbyforge/db db:push` against TEST_DATABASE_URL,
    // the public schema should contain the core tables.
    expect(names).toContain('users');
    expect(names).toContain('servers');
    expect(names).toContain('channels');
  }, 15000);

  it('locks bootstrap irreversibly under concurrent requests', async () => {
    const db = createDb(url);
    const nonce = crypto.randomUUID();
    const instanceId = `integration-${nonce}`;
    const ownerEmail = `integration-${nonce}@example.invalid`;
    let ownerId: string | undefined;

    const bootstrap = () => completeInitialBootstrap(db, {
      instanceId,
      instanceName: `Integration ${nonce}`,
      ownerDisplayName: 'Integration Owner',
      ownerEmail,
      ownerPasswordHash: '$test$not-a-real-password-hash',
      registrationMode: 'invite_only',
      guestAccessEnabled: false,
      seoIndexingEnabled: false,
    });

    try {
      const results = await Promise.allSettled([bootstrap(), bootstrap()]);
      const successes = results.filter((result) => result.status === 'fulfilled');
      const failures = results.filter((result) => result.status === 'rejected');

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        SetupAlreadyCompleteError
      );

      const successful = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof bootstrap>>>).value;
      ownerId = successful.owner.id;
      expect(successful.setup.bootstrapVersion).toBe(2);

      await db.delete(servers).where(eq(servers.ownerUserId, ownerId));
      await db
        .update(instanceSettings)
        .set({ ownerUserId: null })
        .where(eq(instanceSettings.instanceId, instanceId));

      const statusAfterOperationalDamage = await getInstanceBootstrapStatus(db, instanceId);
      expect(statusAfterOperationalDamage.bootstrapComplete).toBe(true);
      await expect(bootstrap()).rejects.toBeInstanceOf(SetupAlreadyCompleteError);
    } finally {
      await db.delete(instanceSettings).where(eq(instanceSettings.instanceId, instanceId));
      if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
    }
  }, 15000);
});
