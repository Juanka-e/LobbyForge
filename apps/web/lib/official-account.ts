/**
 * Official hub accounts.
 *
 * On a self-hosted instance, registering always means joining its
 * community (`createLocalAccount` creates the credential and the first
 * membership in one transaction). The official hub has no community to
 * join at sign-up: an official account is an email/password identity
 * that belongs to nothing yet. It joins communities later — through the
 * directory, an invite, or by creating one — like any other user row.
 *
 * Same `users` table, same scrypt hash, same `/api/auth/login`: nothing
 * about signing in differs between the two deployment modes.
 */
import { users, type DbClient } from '@lobbyforge/db';

export type CreateOfficialAccountResult =
  | { ok: true; user: { id: string; email: string; displayName: string } }
  | { ok: false; error: 'email_exists' };

export async function createOfficialAccount(
  db: DbClient,
  input: { email: string; displayName: string; passwordHash: string; signupChannel?: 'open' }
): Promise<CreateOfficialAccountResult> {
  // `users.email` is unique: of two sign-ups racing for one address,
  // exactly one insert returns a row, so no advisory lock is needed.
  const [user] = await db
    .insert(users)
    .values({
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
      isGuest: false,
      // docs/EMAIL.md §4.2 — every hub sign-up is an open one.
      signupChannel: input.signupChannel ?? 'open',
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  if (!user?.email) return { ok: false, error: 'email_exists' };
  return { ok: true, user: { id: user.id, email: user.email, displayName: user.displayName } };
}
