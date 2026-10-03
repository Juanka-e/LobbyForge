/**
 * security-review FILE-001 / AUTHZ-005: list queries select short image
 * references and the subject's profile visibility — never the stored
 * data URLs. Run against a capturing fake client (no Postgres needed).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';
import { users } from '../schema.js';
import { listMemberSummariesForServer } from '../queries/memberships.js';
import {
  findOrCreateGuestUser,
  getUserById,
  getUserImages,
  updateUserAvatar,
  updateUserBanner,
  updateUserProfile,
  userExists,
} from '../queries/users.js';
import { listDmChannelsForUser } from '../queries/dmChannels.js';
import { listBlockedUsers } from '../queries/userBlocks.js';
import {
  getUserImageAccess,
  getUserImageData,
  toProfileVisibility,
  userImageRefSql,
} from '../queries/userImages.js';

interface Captured {
  fields: Array<Record<string, unknown>>;
  limits: number[];
  wheres: unknown[];
  /** update(...).set(values) */
  sets: Array<Record<string, unknown>>;
  /** insert/update(...).returning(fields) — `undefined` = bare returning() */
  returning: Array<Record<string, unknown> | undefined>;
}

/**
 * select(fields) / update().set().returning(fields) / insert().returning()
 * chains that record what was asked for and resolve queued rows.
 */
function fakeDb(rowsQueue: unknown[][]) {
  const captured: Captured = { fields: [], limits: [], wheres: [], sets: [], returning: [] };
  function chainFor(rows: unknown[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'values', 'onConflictDoNothing']) {
      chain[method] = () => chain;
    }
    chain.where = (condition: unknown) => {
      captured.wheres.push(condition);
      return chain;
    };
    chain.limit = (n: number) => {
      captured.limits.push(n);
      return chain;
    };
    chain.set = (values: Record<string, unknown>) => {
      captured.sets.push(values);
      return chain;
    };
    chain.returning = (fields?: Record<string, unknown>) => {
      captured.returning.push(fields);
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  }
  const db = {
    select(fields: Record<string, unknown>) {
      captured.fields.push(fields);
      return chainFor(rowsQueue.shift() ?? []);
    },
    update() {
      return chainFor(rowsQueue.shift() ?? []);
    },
    insert() {
      return chainFor(rowsQueue.shift() ?? []);
    },
  };
  return { db: db as never, captured };
}

function render(value: unknown): { sql: string; params: unknown[] } {
  if (!is(value, SQL)) throw new Error('expected an SQL fragment');
  return new PgDialect().sqlToQuery(value);
}

/** True when a projection field is the raw image column itself. */
function isRawImageColumn(value: unknown): boolean {
  return value === users.avatarUrl || value === users.bannerUrl;
}

describe('userImageRefSql — security-review FILE-001', () => {
  it('versions data URLs from the image version column + byte length, without hashing the content', () => {
    const { sql } = render(userImageRefSql(users.avatarUrl));
    expect(sql).toContain('md5("users"."avatar_version"::text');
    expect(sql).toContain('octet_length("users"."avatar_url")');
    expect(sql).toContain(`substr("users"."avatar_url", 1, 5) = 'data:'`);
    // A hash of the CONTENT would detoast every multi-MB value per row.
    expect(sql).not.toContain('md5("users"."avatar_url")');
    expect(sql).toContain('substr(md5(');
    expect(sql).toContain(', 1, 12)');
  });

  it('does not version from updated_at — a status / bio edit must not invalidate cached images', () => {
    for (const column of [users.avatarUrl, users.bannerUrl]) {
      expect(render(userImageRefSql(column)).sql).not.toContain('updated_at');
    }
    // Each image has its own version: a new banner leaves the avatar token alone.
    const banner = render(userImageRefSql(users.bannerUrl)).sql;
    expect(banner).toContain('md5("users"."banner_version"::text');
    expect(banner).not.toContain('avatar_version');
  });

  it('refuses a column that has no version', () => {
    expect(() => userImageRefSql(users.displayName)).toThrow(/avatarUrl or users\.bannerUrl/);
  });

  it('passes only short https URLs through and hides deleted users', () => {
    const { sql } = render(userImageRefSql(users.bannerUrl));
    expect(sql).toContain(`substr("users"."banner_url", 1, 8) = 'https://'`);
    expect(sql).toContain('octet_length("users"."banner_url") <= 2048');
    expect(sql).toContain('"users"."deleted_at" is not null then null');
  });
});

describe('toProfileVisibility', () => {
  it('keeps known scopes and defaults everything else to server members', () => {
    expect(toProfileVisibility('everyone')).toBe('everyone');
    expect(toProfileVisibility('nobody')).toBe('nobody');
    expect(toProfileVisibility('friends')).toBe('friends');
    expect(toProfileVisibility(null)).toBe('server_members');
    expect(toProfileVisibility('admins')).toBe('server_members');
  });
});

describe('listMemberSummariesForServer — security-review FILE-001 / AUTHZ-005', () => {
  const row = {
    userId: 'u-1',
    membershipId: 'm-1',
    displayName: null,
    globalDisplayName: 'Alice',
    nickname: null,
    avatarRef: '0123456789ab',
    bannerRef: null,
    profileVisibility: 'nobody',
    isGuest: false,
    roleName: null,
    roleColor: null,
    roleIcon: null,
    statusText: 'busy',
    bio: 'hi',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('selects image references, never the image columns, and returns every member', async () => {
    const { db, captured } = fakeDb([[row], []]);
    const result = await listMemberSummariesForServer(db, 'server-1');

    const projection = captured.fields[0]!;
    expect(projection).not.toHaveProperty('avatarUrl');
    expect(projection).not.toHaveProperty('bannerUrl');
    expect(Object.values(projection).some(isRawImageColumn)).toBe(false);
    expect(render(projection.avatarRef).sql).toContain('octet_length("users"."avatar_url")');
    expect(render(projection.bannerRef).sql).toContain('octet_length("users"."banner_url")');
    expect(render(projection.profileVisibility).sql).toContain(`->> 'profileVisibility'`);
    // No cap: the lobby list, mentions, voice rosters and the admin page
    // all treat this as the complete member set.
    expect(captured.limits).toEqual([]);

    expect(result).toEqual([
      expect.objectContaining({
        userId: 'u-1',
        displayName: 'Alice',
        avatarRef: '0123456789ab',
        bannerRef: null,
        profileVisibility: 'nobody',
        statusText: 'busy',
        bio: 'hi',
        roles: [],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('data:');
  });

  it('applies a limit only when the caller asks for one', async () => {
    const { db, captured } = fakeDb([[], []]);
    await listMemberSummariesForServer(db, 'server-1', { limit: 1_000_000 });
    expect(captured.limits).toEqual([1_000_000]);
  });

  it('loads role links scoped by server, not as one bind parameter per member', async () => {
    const { db, captured } = fakeDb([[row], [
      { membershipId: 'm-1', id: 'r-1', name: 'Mod', color: null, icon: null, position: 2, displaySeparately: true },
      { membershipId: 'm-gone', id: 'r-1', name: 'Mod', color: null, icon: null, position: 2, displaySeparately: true },
    ]]);
    const [summary] = await listMemberSummariesForServer(db, 'server-1');
    const roleWhere = render(captured.wheres[1]);
    expect(roleWhere.sql).toBe('"memberships"."server_id" = $1');
    expect(roleWhere.params).toEqual(['server-1']);
    expect(summary!.roles).toEqual([
      { id: 'r-1', name: 'Mod', color: null, icon: null, position: 2, displaySeparately: true },
    ]);
  });

  it('defaults a missing settings row to server-members visibility', async () => {
    const { db } = fakeDb([[{ ...row, profileVisibility: null }], []]);
    const [summary] = await listMemberSummariesForServer(db, 'server-1');
    expect(summary!.profileVisibility).toBe('server_members');
  });
});

describe('listDmChannelsForUser — security-review FILE-001 / AUTHZ-005', () => {
  it('returns the reference, the visibility and the shared-server flag', async () => {
    const lastMessageAt = new Date('2026-01-02T00:00:00Z');
    const channel = { id: 'dm-1', lastMessageAt };
    const { db, captured } = fakeDb([
      [
        { channel, otherId: 'me', otherName: 'Me', otherAvatarRef: null, otherProfileVisibility: null, sharesServer: true },
        { channel, otherId: 'bob', otherName: 'Bob', otherAvatarRef: 'abcdefabcdef', otherProfileVisibility: 'everyone', sharesServer: false },
      ],
    ]);
    const result = await listDmChannelsForUser(db, 'me');

    const projection = captured.fields[0]!;
    expect(Object.values(projection).some(isRawImageColumn)).toBe(false);
    const shares = render(projection.sharesServer);
    expect(shares.sql).toContain('from memberships viewer_m');
    expect(shares.params).toEqual(['me']);
    expect(result).toEqual([
      {
        id: 'dm-1',
        otherUserId: 'bob',
        otherUserDisplayName: 'Bob',
        otherUserAvatarRef: 'abcdefabcdef',
        otherUserProfileVisibility: 'everyone',
        sharesServerWithOtherUser: false,
        lastMessageAt,
      },
    ]);
  });
});

describe('listBlockedUsers — security-review FILE-001 / AUTHZ-005', () => {
  it('returns the reference instead of the avatar', async () => {
    const createdAt = new Date();
    const { db, captured } = fakeDb([
      [
        {
          id: 'b-1',
          blockerUserId: 'me',
          blockedUserId: 'eve',
          blockedDisplayName: 'Eve',
          blockedAvatarRef: 'abcdefabcdef',
          blockedProfileVisibility: 'nobody',
          sharesServerWithBlocked: true,
          createdAt,
        },
      ],
    ]);
    const [block] = await listBlockedUsers(db, 'me');
    expect(Object.values(captured.fields[0]!).some(isRawImageColumn)).toBe(false);
    expect(block).toEqual(
      expect.objectContaining({
        blockedAvatarRef: 'abcdefabcdef',
        blockedProfileVisibility: 'nobody',
        sharesServerWithBlocked: true,
      })
    );
    expect(block).not.toHaveProperty('blockedAvatarUrl');
  });
});

describe('user image route queries — security-review FILE-001', () => {
  it('decides access without selecting the image', async () => {
    const { db, captured } = fakeDb([[{ hasImage: true, profileVisibility: 'friends', sharesServer: true }]]);
    const access = await getUserImageAccess(db, { userId: 'u-1', viewerUserId: 'v-1', kind: 'banner' });
    expect(access).toEqual({ hasImage: true, profileVisibility: 'friends', sharesServer: true });
    const projection = captured.fields[0]!;
    expect(Object.values(projection).some(isRawImageColumn)).toBe(false);
    expect(render(projection.hasImage).sql).toBe('("users"."banner_url" is not null)');
    // The subject is a bound parameter, never a `users.id` column
    // reference: Drizzle leaves columns unqualified in a single-table
    // select, and a bare "id" inside these subqueries was ambiguous (see
    // user-images.integration.test.ts).
    expect(render(projection.sharesServer).params).toEqual(['v-1', 'u-1']);
    expect(render(projection.profileVisibility).params).toEqual(['u-1']);
    expect(render(projection.sharesServer).sql).not.toContain('"users"."id"');
    expect(render(projection.profileVisibility).sql).not.toContain('"users"."id"');
  });

  it('returns null for a missing or deleted user', async () => {
    const { db } = fakeDb([[]]);
    expect(await getUserImageAccess(db, { userId: 'u-1', viewerUserId: 'v-1', kind: 'avatar' })).toBeNull();
  });

  it('reads the value and its reference together, null when empty', async () => {
    const { db } = fakeDb([[{ value: 'data:image/png;base64,AAAA', ref: '0123456789ab' }], [{ value: null, ref: null }]]);
    expect(await getUserImageData(db, 'u-1', 'avatar')).toEqual({
      value: 'data:image/png;base64,AAAA',
      ref: '0123456789ab',
    });
    expect(await getUserImageData(db, 'u-1', 'avatar')).toBeNull();
  });
});

describe('single-user reads and writes — security-review FILE-001', () => {
  const IMAGE_FREE_FIELDS = [
    'id', 'email', 'displayName', 'locale', 'isGuest', 'guestKey',
    'statusText', 'bio', 'createdAt', 'updatedAt', 'deletedAt',
  ];
  const row = {
    id: 'u-1', email: null, displayName: 'Alice', locale: 'en', isGuest: false, guestKey: null,
    statusText: null, bio: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
  };

  /** The projection names its columns and none of them is an image (or the password hash). */
  function expectImageFree(fields: Record<string, unknown> | undefined) {
    expect(fields).toBeDefined();
    expect(Object.keys(fields!).sort()).toEqual([...IMAGE_FREE_FIELDS].sort());
    expect(Object.values(fields!).some(isRawImageColumn)).toBe(false);
    expect(Object.values(fields!)).not.toContain(users.passwordHash);
  }

  it('getUserById selects every column except the images and the password hash', async () => {
    const { db, captured } = fakeDb([[row], []]);
    expect(await getUserById(db, 'u-1')).toEqual(row);
    expectImageFree(captured.fields[0]);
    expect(await getUserById(db, 'missing')).toBeNull();
  });

  it('userExists selects the id only', async () => {
    const { db, captured } = fakeDb([[{ id: 'u-1' }], []]);
    expect(await userExists(db, 'u-1')).toBe(true);
    expect(await userExists(db, 'missing')).toBe(false);
    expect(captured.fields[0]).toEqual({ id: users.id });
  });

  it('getUserImages is the explicit way to read both images', async () => {
    const { db, captured } = fakeDb([[{ avatarUrl: 'data:image/png;base64,AAAA', bannerUrl: null }], []]);
    expect(await getUserImages(db, 'u-1')).toEqual({ avatarUrl: 'data:image/png;base64,AAAA', bannerUrl: null });
    expect(captured.fields[0]).toEqual({ avatarUrl: users.avatarUrl, bannerUrl: users.bannerUrl });
    expect(await getUserImages(db, 'missing')).toBeNull();
  });

  it('findOrCreateGuestUser never pulls a returning guest\'s images', async () => {
    const { db, captured } = fakeDb([[], [row]]);
    expect(await findOrCreateGuestUser(db, { guestKey: 'g_1', displayName: 'Guest' })).toEqual(row);
    expectImageFree(captured.returning[0]);
    expectImageFree(captured.fields[0]);
  });

  it('updateUserAvatar bumps avatar_version only and returns the written value, not the stored images', async () => {
    const { db, captured } = fakeDb([[row]]);
    const now = new Date('2026-10-03T00:00:00Z');
    const result = await updateUserAvatar(db, 'u-1', 'data:image/png;base64,NEW', now);
    const set = captured.sets[0]!;
    expect(set.avatarUrl).toBe('data:image/png;base64,NEW');
    expect(render(set.avatarVersion).sql).toBe('"users"."avatar_version" + 1');
    expect(set).not.toHaveProperty('bannerVersion');
    expect(set.updatedAt).toBe(now);
    expectImageFree(captured.returning[0]);
    expect(result).toEqual({ ...row, avatarUrl: 'data:image/png;base64,NEW' });
    expect(result).not.toHaveProperty('bannerUrl');
  });

  it('updateUserBanner bumps banner_version — removal included', async () => {
    const { db, captured } = fakeDb([[row], [row]]);
    await updateUserBanner(db, 'u-1', 'data:image/png;base64,NEW');
    const result = await updateUserBanner(db, 'u-1', null);
    for (const set of captured.sets) {
      expect(render(set.bannerVersion).sql).toBe('"users"."banner_version" + 1');
      expect(set).not.toHaveProperty('avatarVersion');
    }
    expect(captured.sets[1]!.bannerUrl).toBeNull();
    expectImageFree(captured.returning[1]);
    expect(result).toEqual({ ...row, bannerUrl: null });
    expect(result).not.toHaveProperty('avatarUrl');
  });

  it('updateUserProfile leaves the image versions alone and does not read the images back', async () => {
    const { db, captured } = fakeDb([[row]]);
    await updateUserProfile(db, 'u-1', { statusText: 'brb' });
    const set = captured.sets[0]!;
    expect(set.statusText).toBe('brb');
    expect(set).not.toHaveProperty('avatarVersion');
    expect(set).not.toHaveProperty('bannerVersion');
    expectImageFree(captured.returning[0]);
  });

  it('a missing user is an error on every write', async () => {
    const { db } = fakeDb([[], [], []]);
    await expect(updateUserAvatar(db, 'missing', 'data:x')).rejects.toThrow('not found');
    await expect(updateUserBanner(db, 'missing', null)).rejects.toThrow('not found');
    await expect(updateUserProfile(db, 'missing', { bio: 'x' })).rejects.toThrow('not found');
  });
});
