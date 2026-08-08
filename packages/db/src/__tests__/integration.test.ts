import { describe, it, expect } from 'vitest';
import { createDb } from '../client.js';
import { and, eq, sql } from 'drizzle-orm';
import { instanceSettings, invites, memberships, servers, users } from '../schema.js';
import {
  completeInitialBootstrap,
  getInstanceBootstrapStatus,
  SetupAlreadyCompleteError,
} from '../queries/instanceSettings.js';
import { createLocalAccount } from '../queries/users.js';
import { createInvite } from '../queries/invites.js';
import {
  createUserIdentityLink,
  getIdentityLinkByProviderSubject,
  listUserIdentityLinks,
} from '../queries/userIdentityLinks.js';

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

  it('creates a local account and default membership atomically', async () => {
    const db = createDb(url);
    const setup = await getInstanceBootstrapStatus(db);
    if (!setup.firstServerId) throw new Error('Default instance has no first server');
    const email = `registration-${crypto.randomUUID()}@example.invalid`;
    let userId: string | undefined;

    try {
      const result = await createLocalAccount(db, {
        email,
        displayName: 'Registration Test',
        passwordHash: '$test$not-a-real-password-hash',
        serverId: setup.firstServerId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      userId = result.user.id;

      const rows = await db
        .select({ id: memberships.id, roleId: memberships.roleId })
        .from(memberships)
        .where(and(eq(memberships.serverId, setup.firstServerId), eq(memberships.userId, userId)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.roleId).toBeTruthy();

      const duplicate = await createLocalAccount(db, {
        email,
        displayName: 'Duplicate',
        passwordHash: '$test$duplicate',
        serverId: setup.firstServerId,
      });
      expect(duplicate).toEqual({ ok: false, error: 'email_exists' });
    } finally {
      if (userId) await db.delete(users).where(eq(users.id, userId));
    }
  }, 15000);

  it('creates an invite-only local account and consumes the invite atomically', async () => {
    const db = createDb(url);
    const setup = await getInstanceBootstrapStatus(db);
    if (!setup.firstServerId || !setup.ownerUserId) throw new Error('Default instance is not bootstrapped');
    const email = `invite-registration-${crypto.randomUUID()}@example.invalid`;
    const invite = await createInvite(db, {
      serverId: setup.firstServerId,
      createdBy: setup.ownerUserId,
      maxUses: 1,
    });
    let userId: string | undefined;

    try {
      const result = await createLocalAccount(db, {
        email,
        displayName: 'Invite Registration Test',
        passwordHash: '$test$not-a-real-password-hash',
        inviteCode: invite.code,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      userId = result.user.id;

      const [storedInvite] = await db
        .select({ currentUses: invites.currentUses })
        .from(invites)
        .where(eq(invites.id, invite.id));
      expect(storedInvite?.currentUses).toBe(1);

      const exhaustedEmail = `invite-exhausted-${crypto.randomUUID()}@example.invalid`;
      const exhausted = await createLocalAccount(db, {
        email: exhaustedEmail,
        displayName: 'Must Roll Back',
        passwordHash: '$test$not-a-real-password-hash',
        inviteCode: invite.code,
      });
      expect(exhausted).toEqual({ ok: false, error: 'exhausted' });
      const orphan = await db.select({ id: users.id }).from(users).where(eq(users.email, exhaustedEmail));
      expect(orphan).toHaveLength(0);
    } finally {
      await db.delete(invites).where(eq(invites.id, invite.id));
      if (userId) await db.delete(users).where(eq(users.id, userId));
    }
  }, 15000);

  it('links an external subject to exactly one local account without storing tokens', async () => {
    const db = createDb(url);
    const nonce = crypto.randomUUID();
    const inserted = await db
      .insert(users)
      .values([
        { email: `identity-a-${nonce}@example.invalid`, displayName: 'Identity A' },
        { email: `identity-b-${nonce}@example.invalid`, displayName: 'Identity B' },
      ])
      .returning({ id: users.id });
    const [userA, userB] = inserted;
    if (!userA || !userB) throw new Error('Identity integration users were not created');

    try {
      const link = await createUserIdentityLink(db, {
        userId: userA.id,
        provider: 'lobbyforge',
        providerSubject: `official-${nonce}`,
        providerEmail: `official-${nonce}@example.invalid`,
        emailVerified: true,
        claims: { displayName: 'Official User' },
      });
      expect(link.userId).toBe(userA.id);
      expect(await getIdentityLinkByProviderSubject(db, 'lobbyforge', `official-${nonce}`))
        .toMatchObject({ id: link.id, userId: userA.id });
      expect(await listUserIdentityLinks(db, userA.id)).toHaveLength(1);

      await expect(createUserIdentityLink(db, {
        userId: userB.id,
        provider: 'lobbyforge',
        providerSubject: `official-${nonce}`,
      })).rejects.toBeDefined();
    } finally {
      await db.delete(users).where(eq(users.id, userA.id));
      await db.delete(users).where(eq(users.id, userB.id));
    }
  }, 15000);
});
