/**
 * User queries — thin wrappers over the Drizzle client.
 *
 * These functions take a `DbClient` as their first argument and never read
 * from the environment or hold state, so they are trivially mockable in
 * route-level tests and re-usable across web / desktop / future CLI.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { membershipRoles, memberships, roles, servers, users } from '../schema.js';
import { redeemInvite, type RedeemInviteError } from './invites.js';
import { EVERYONE_ROLE_NAME } from './roles.js';

export interface UserRow {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  locale: string;
  isGuest: boolean;
  guestKey: string | null;
  statusText: string | null;
  bio: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Find an existing guest user by `guestKey`, or create one.
 *
 * Idempotent: the same `gid` always returns the same `UserRow` (or `null`
 * only if the DB call itself fails). The cookie's `gid` becomes the
 * `guestKey` — see `apps/web/lib/guest-session.ts` for the wire format.
 */
export async function findOrCreateGuestUser(
  db: DbClient,
  input: { guestKey: string; displayName: string; locale?: string }
): Promise<UserRow | null> {
  // Fast path: try the insert. On unique-constraint hit (returning guest),
  // fall through to the select.
  const baseValues = {
    displayName: input.displayName,
    isGuest: true as const,
    guestKey: input.guestKey,
    locale: input.locale ?? 'en',
  };

  try {
    const inserted = await db
      .insert(users)
      .values(baseValues)
      .onConflictDoNothing({ target: users.guestKey })
      .returning();
    if (inserted.length > 0) {
      return inserted[0] as UserRow;
    }
  } catch (err) {
    // Some Postgres clients raise on the conflict path rather than returning
    // an empty array. Fall through to the select.
    if (!isUniqueViolation(err)) throw err;
  }

  const found = await db
    .select()
    .from(users)
    .where(eq(users.guestKey, input.guestKey))
    .limit(1);
  if (found.length === 0) {
    // The row was deleted between the conflict and the select (or the
    // schema isn't migrated). Return null so the caller can surface a
    // 503-ish error rather than masquerading as success.
    return null;
  }
  return found[0] as UserRow;
}

export async function getUserById(db: DbClient, id: string): Promise<UserRow | null> {
  const found = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return (found[0] as UserRow | undefined) ?? null;
}

export async function getUserCredentialsByEmail(
  db: DbClient,
  email: string
): Promise<{ id: string; email: string; displayName: string; passwordHash: string | null; deletedAt: Date | null } | null> {
  const [found] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!found?.email) return null;
  return { ...found, email: found.email };
}

export interface UserCredentials {
  id: string;
  email: string | null;
  displayName: string;
  passwordHash: string | null;
  isGuest: boolean;
  deletedAt: Date | null;
}

export async function getUserCredentialsById(
  db: DbClient,
  id: string
): Promise<UserCredentials | null> {
  const [found] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      isGuest: users.isGuest,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return (found as UserCredentials | undefined) ?? null;
}

/** Replace a password only if the credential verified by the caller is still current. */
export async function replaceUserPasswordHash(
  db: DbClient,
  input: { userId: string; currentPasswordHash: string; newPasswordHash: string },
  now: Date = new Date()
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ passwordHash: input.newPasswordHash, updatedAt: now })
    .where(and(
      eq(users.id, input.userId),
      eq(users.passwordHash, input.currentPasswordHash)
    ))
    .returning({ id: users.id });
  return updated.length === 1;
}

export type CreateLocalAccountError =
  | 'email_exists'
  | 'server_unavailable'
  | 'not_found'
  | 'expired'
  | 'exhausted'
  | 'already_member'
  | 'no_everyone_role'
  | 'banned';

export type CreateLocalAccountResult =
  | { ok: true; user: { id: string; email: string; displayName: string }; serverId: string }
  | { ok: false; error: CreateLocalAccountError };

class LocalAccountRegistrationError extends Error {
  constructor(readonly reason: CreateLocalAccountError) {
    super(reason);
    this.name = 'LocalAccountRegistrationError';
  }
}

/** Create the credential and its first membership as one atomic operation. */
export async function createLocalAccount(
  db: DbClient,
  input: {
    email: string;
    displayName: string;
    passwordHash: string;
    serverId?: string;
    inviteCode?: string;
  }
): Promise<CreateLocalAccountResult> {
  try {
    return await db.transaction(async (tx) => {
      const executor = tx as unknown as DbClient;
      const email = input.email.trim().toLowerCase();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lobbyforge:register:${email}`}))`);

      const [user] = await tx
        .insert(users)
        .values({
          email,
          displayName: input.displayName.trim(),
          passwordHash: input.passwordHash,
          isGuest: false,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, displayName: users.displayName });
      if (!user?.email) throw new LocalAccountRegistrationError('email_exists');

      if (input.inviteCode) {
        const redeemed = await redeemInvite(executor, input.inviteCode, user.id);
        if (!redeemed.ok) {
          throw new LocalAccountRegistrationError(redeemed.error as RedeemInviteError);
        }
        return { ok: true as const, user: { ...user, email: user.email }, serverId: redeemed.serverId };
      }

      if (!input.serverId) throw new LocalAccountRegistrationError('server_unavailable');
      const [server] = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, input.serverId), isNull(servers.deletedAt)))
        .limit(1);
      if (!server) throw new LocalAccountRegistrationError('server_unavailable');

      const [everyone] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.serverId, server.id), eq(roles.name, EVERYONE_ROLE_NAME)))
        .limit(1);
      if (!everyone) throw new LocalAccountRegistrationError('no_everyone_role');

      const [membership] = await tx
        .insert(memberships)
        .values({ serverId: server.id, userId: user.id, roleId: everyone.id })
        .returning({ id: memberships.id });
      if (!membership) throw new LocalAccountRegistrationError('server_unavailable');
      await tx.insert(membershipRoles).values({ membershipId: membership.id, roleId: everyone.id });

      return { ok: true as const, user: { ...user, email: user.email }, serverId: server.id };
    });
  } catch (error) {
    if (error instanceof LocalAccountRegistrationError) {
      return { ok: false, error: error.reason };
    }
    throw error;
  }
}

/**
 * Mark a user as soft-deleted. Used when a guest wants to "forget" their
 * identity. Idempotent: deleting a user that is already deleted is a no-op.
 */
export async function softDeleteUser(db: DbClient, id: string, now: Date = new Date()): Promise<void> {
  await db
    .update(users)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(users.id, id));
}

/**
 * Update the user's avatar URL. The caller is responsible for producing a
 * data URL (e.g. from a cropper) or an absolute storage URL.
 */
export async function updateUserAvatar(
  db: DbClient,
  id: string,
  avatarUrl: string,
  now: Date = new Date()
): Promise<UserRow> {
  const updated = await db
    .update(users)
    .set({ avatarUrl, updatedAt: now })
    .where(eq(users.id, id))
    .returning();
  if (!updated[0]) {
    throw new Error(`User ${id} not found`);
  }
  return {
    id: updated[0].id,
    email: updated[0].email,
    displayName: updated[0].displayName,
    avatarUrl: updated[0].avatarUrl,
    bannerUrl: updated[0].bannerUrl,
    locale: updated[0].locale,
    isGuest: updated[0].isGuest,
    guestKey: updated[0].guestKey,
    statusText: updated[0].statusText,
    bio: updated[0].bio,
    createdAt: updated[0].createdAt,
    updatedAt: updated[0].updatedAt,
    deletedAt: updated[0].deletedAt,
  };
}

/**
 * Update the user's profile banner URL. The route layer validates accepted
 * image data URL types and size until this moves to object storage.
 */
export async function updateUserBanner(
  db: DbClient,
  id: string,
  bannerUrl: string | null,
  now: Date = new Date()
): Promise<UserRow> {
  const updated = await db
    .update(users)
    .set({ bannerUrl, updatedAt: now })
    .where(eq(users.id, id))
    .returning();
  if (!updated[0]) {
    throw new Error(`User ${id} not found`);
  }
  return updated[0] as UserRow;
}

export async function updateUserProfile(
  db: DbClient,
  id: string,
  input: { displayName?: string; statusText?: string | null; bio?: string | null },
  now: Date = new Date()
): Promise<UserRow> {
  const values: Partial<typeof users.$inferInsert> = { updatedAt: now };
  if (input.displayName !== undefined) values.displayName = input.displayName.trim();
  if (input.statusText !== undefined) values.statusText = input.statusText?.trim() || null;
  if (input.bio !== undefined) values.bio = input.bio?.trim() || null;
  const updated = await db.update(users).set(values).where(eq(users.id, id)).returning();
  if (!updated[0]) throw new Error(`User ${id} not found`);
  return updated[0] as UserRow;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string };
  // Postgres SQLSTATE for unique_violation is '23505'.
  return e.code === '23505';
}

// Internal helper exposed for tests that need to verify the unique-violation
// detection without going through the Drizzle error shape.
export const __test__ = { isUniqueViolation };

// Suppress unused import warning for `sql` if tree-shaken out.
export const __sql = sql;
