/**
 * User queries — thin wrappers over the Drizzle client.
 *
 * These functions take a `DbClient` as their first argument and never read
 * from the environment or hold state, so they are trivially mockable in
 * route-level tests and re-usable across web / desktop / future CLI.
 */
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { users } from '../schema.js';

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
  input: { displayName?: string; statusText?: string | null },
  now: Date = new Date()
): Promise<UserRow> {
  const values: Partial<typeof users.$inferInsert> = { updatedAt: now };
  if (input.displayName !== undefined) values.displayName = input.displayName.trim();
  if (input.statusText !== undefined) values.statusText = input.statusText?.trim() || null;
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
