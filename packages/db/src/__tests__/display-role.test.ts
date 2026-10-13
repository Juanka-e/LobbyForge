/**
 * The display role (the Members page's Role column, the lobby's name
 * colour, `memberships.role_id`): the highest role a member holds other
 * than `@everyone`.
 *
 * The A-to-Z run found a moderator shown as "@EVERYONE": `setMemberRoles`
 * stored the FIRST id sent, and the role UI and the profile card send the
 * set with `@everyone` first. Readers now work the display role out from
 * the whole set, so rows stored that way show right without a migration.
 *
 * Against a recording fake client — no Postgres needed.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { listMemberSummariesForServer, setMemberRoles } from '../queries/memberships.js';
import { countRoleHolders, listMembersForServer, pickDisplayRole } from '../queries/roles.js';

interface Recorded {
  /** `update(...).set(values)` */
  sets: Array<Record<string, unknown>>;
  /** `insert(...).values(values)` */
  inserted: unknown[];
  /** `.where(condition)`, in call order */
  wheres: unknown[];
}

/** Every awaited chain resolves the next queued result, in call order. */
function fakeDb(results: unknown[][]) {
  const recorded: Recorded = { sets: [], inserted: [], wheres: [] };
  function chain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit', 'returning', 'onConflictDoNothing']) {
      c[method] = () => c;
    }
    c.where = (condition: unknown) => {
      recorded.wheres.push(condition);
      return c;
    };
    c.set = (values: Record<string, unknown>) => {
      recorded.sets.push(values);
      return c;
    };
    c.values = (values: unknown) => {
      recorded.inserted.push(values);
      return c;
    };
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve, reject);
    return c;
  }
  const db = { select: chain, update: chain, insert: chain, delete: chain };
  return { db: db as never, recorded };
}

const EVERYONE = { id: 'r-everyone', name: '@everyone', position: 0 };
const MOD = { id: 'r-mod', name: 'Moderator', position: 5 };
const VIP = { id: 'r-vip', name: 'VIP', position: 2 };

describe('pickDisplayRole', () => {
  it('is the highest role other than @everyone', () => {
    expect(pickDisplayRole([EVERYONE, VIP, MOD])).toBe(MOD);
    expect(pickDisplayRole([MOD, EVERYONE])).toBe(MOD);
  });

  it('is null for @everyone alone, or no roles at all', () => {
    expect(pickDisplayRole([EVERYONE])).toBeNull();
    expect(pickDisplayRole([])).toBeNull();
  });

  it('gives a tie to the role listed first', () => {
    const twin = { id: 'r-twin', name: 'Twin', position: 5 };
    expect(pickDisplayRole([MOD, twin])).toBe(MOD);
    expect(pickDisplayRole([twin, MOD])).toBe(twin);
  });
});

describe('setMemberRoles', () => {
  const membership = {
    id: 'm-1',
    serverId: 's-1',
    userId: 'u-1',
    roleId: null,
    nickname: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('stores the highest role as the display role, even when @everyone is sent first', async () => {
    const { db, recorded } = fakeDb([[membership], [EVERYONE, MOD, VIP]]);
    const result = await setMemberRoles(db, 's-1', 'u-1', [EVERYONE.id, VIP.id, MOD.id]);
    expect(recorded.sets).toEqual([{ roleId: MOD.id }]);
    expect(result.roleId).toBe(MOD.id);
    // Every role sent is still held.
    expect(recorded.inserted).toEqual([
      [EVERYONE.id, VIP.id, MOD.id].map((roleId) => ({ membershipId: 'm-1', roleId })),
    ]);
  });

  it('stores no display role for @everyone alone, or an empty set', async () => {
    const onlyEveryone = fakeDb([[membership], [EVERYONE]]);
    expect((await setMemberRoles(onlyEveryone.db, 's-1', 'u-1', [EVERYONE.id])).roleId).toBeNull();
    expect(onlyEveryone.recorded.sets).toEqual([{ roleId: null }]);

    const none = fakeDb([[membership]]);
    expect((await setMemberRoles(none.db, 's-1', 'u-1', [])).roleId).toBeNull();
    expect(none.recorded.inserted).toEqual([]);
  });
});

describe('listMembersForServer', () => {
  it('names the display role from the whole set, not the stored column', async () => {
    const { db } = fakeDb([
      [
        // Stored before the display rule: @everyone in memberships.role_id.
        {
          membershipId: 'm-1',
          userId: 'u-mod',
          legacyRoleId: EVERYONE.id,
          legacyRoleName: EVERYONE.name,
          legacyRolePosition: 0,
          legacyRolePermissions: ['send_messages'],
        },
        { membershipId: 'm-2', userId: 'u-new', legacyRoleId: null, legacyRoleName: null, legacyRolePosition: null, legacyRolePermissions: null },
      ],
      [
        { membershipId: 'm-1', ...EVERYONE, permissions: ['send_messages'] },
        { membershipId: 'm-1', ...MOD, permissions: ['kick_members'] },
        { membershipId: 'm-2', ...EVERYONE, permissions: ['send_messages'] },
      ],
    ]);
    const [mod, newcomer] = await listMembersForServer(db, 's-1');
    expect(mod).toEqual({
      userId: 'u-mod',
      roleId: MOD.id,
      roleIds: [EVERYONE.id, MOD.id],
      roleName: 'Moderator',
      rolePosition: 5,
      permissions: ['kick_members'],
    });
    expect(newcomer).toEqual({
      userId: 'u-new',
      roleId: null,
      roleIds: [EVERYONE.id],
      roleName: null,
      rolePosition: null,
      permissions: [],
    });
  });

  it('still counts a legacy role the join table does not list', async () => {
    const { db } = fakeDb([
      [{ membershipId: 'm-1', userId: 'u-old', legacyRoleId: MOD.id, legacyRoleName: MOD.name, legacyRolePosition: 5, legacyRolePermissions: ['kick_members'] }],
      [{ membershipId: 'm-1', ...EVERYONE, permissions: [] }],
    ]);
    const [old] = await listMembersForServer(db, 's-1');
    expect(old).toMatchObject({ roleId: MOD.id, roleName: 'Moderator', roleIds: [MOD.id, EVERYONE.id] });
  });
});

describe('listMemberSummariesForServer', () => {
  const row = {
    userId: 'u-mod',
    membershipId: 'm-1',
    displayName: null,
    globalDisplayName: 'Ada',
    nickname: null,
    avatarRef: null,
    bannerRef: null,
    profileVisibility: 'server_members',
    isGuest: false,
    legacyRoleId: EVERYONE.id,
    legacyRoleName: EVERYONE.name,
    legacyRoleColor: null,
    legacyRoleIcon: null,
    legacyRolePosition: 0,
    legacyRoleDisplaySeparately: false,
    statusText: null,
    bio: null,
    joinedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const link = (role: { id: string; name: string; position: number }, extra: Record<string, unknown> = {}) => ({
    membershipId: 'm-1',
    ...role,
    color: null,
    icon: null,
    displaySeparately: false,
    ...extra,
  });

  it('shows the highest role other than @everyone, with its colour and icon', async () => {
    const { db } = fakeDb([[row], [link(EVERYONE), link(MOD, { color: '#ff0000', icon: 'shield' })]]);
    const [summary] = await listMemberSummariesForServer(db, 's-1');
    expect(summary).toMatchObject({ roleName: 'Moderator', roleColor: '#ff0000', roleIcon: 'shield' });
    expect(summary!.roles.map((role) => role.id)).toEqual([MOD.id, EVERYONE.id]);
  });

  it('shows no role name for @everyone alone (the UI says Member or Guest)', async () => {
    const { db } = fakeDb([[row], [link(EVERYONE)]]);
    const [summary] = await listMemberSummariesForServer(db, 's-1');
    expect(summary).toMatchObject({ roleName: null, roleColor: null, roleIcon: null });
  });

  it('folds in a legacy display role the join table does not list', async () => {
    const legacy = { ...row, legacyRoleId: MOD.id, legacyRoleName: MOD.name, legacyRolePosition: 5, legacyRoleDisplaySeparately: true };
    const { db } = fakeDb([[legacy], [link(EVERYONE)]]);
    const [summary] = await listMemberSummariesForServer(db, 's-1');
    expect(summary!.roleName).toBe('Moderator');
    expect(summary!.roles[0]).toEqual({ id: MOD.id, name: 'Moderator', color: null, icon: null, position: 5, displaySeparately: true });
  });
});

describe('countRoleHolders — the Roles page', () => {
  it('counts each holder once: the legacy column only where the join table lacks the role', async () => {
    const { db, recorded } = fakeDb([
      // The join table: three hold @everyone, two hold Moderator.
      [
        { roleId: EVERYONE.id, count: 3 },
        { roleId: MOD.id, count: 2 },
      ],
      // The legacy column, rows the join table does not mirror: one VIP.
      [{ roleId: VIP.id, count: 1 }],
    ]);
    const counts = await countRoleHolders(db, 's-1');
    expect(Object.fromEntries(counts)).toEqual({ [EVERYONE.id]: 3, [MOD.id]: 2, [VIP.id]: 1 });

    const legacy = new PgDialect().sqlToQuery(recorded.wheres[1] as SQL);
    // The subquery names "memberships" itself: a single-table select renders
    // its own columns unqualified, and membership_roles has an "id" and a
    // "role_id" of its own.
    expect(legacy.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "membership_roles" AS "held" WHERE "held"."membership_id" = "memberships"."id" AND "held"."role_id" = "memberships"."role_id")'
    );
    expect(legacy.params).toEqual(['s-1']);
  });
});
