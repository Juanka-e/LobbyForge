/**
 * Email verification, email change and password reset (0046,
 * docs/EMAIL.md §3.1, §4): the `email_tokens` challenges and the account
 * columns they act on.
 *
 * A challenge is a link token and a 6-digit code sent in one email. This
 * package only ever sees their HASHES (the web app hashes the link token
 * with sha256 and HMACs the code with a key it derives from the session
 * secret), and it never compares them: it finds rows, RESERVES code
 * attempts and CONSUMES. A code submission first reserves an attempt (one
 * conditional UPDATE that counts it while the cap, the code window and the
 * challenge allow), and only then is the code compared — so concurrent
 * guesses can never exceed the cap. Consuming is one conditional UPDATE
 * (`consumed_at IS NULL AND expires_at > now()`, plus the code window and
 * attempt cap for a code), so of two submissions racing for one challenge
 * exactly one wins. The action it proves (verify the address, apply the
 * change, set the new password) runs in the same transaction.
 *
 * Every write of a password or an address drops the account's live
 * challenges it makes stale, in the same transaction: a password write
 * drops `change` and `reset` (a pending change started with the old
 * password must not survive the reset that throws its starter out), an
 * address change drops `reset` and `verify` (they went to the old address).
 *
 * Timestamps go through the query builder (never raw `execute`, which
 * hands them back as strings).
 */
import { and, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { isPgUniqueViolation } from '../pg-errors.js';
import { emailTokens, users } from '../schema.js';

type Transaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
type Executor = DbClient | Transaction;

export type EmailTokenPurpose = 'verify' | 'change' | 'reset';
export const EMAIL_TOKEN_PURPOSES: readonly EmailTokenPurpose[] = ['verify', 'change', 'reset'];

export interface EmailTokenRow {
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  targetEmail: string;
  tokenHash: Buffer;
  codeHash: Buffer;
  codeAttempts: number;
  expiresAt: Date;
  codeExpiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

function toTokenRow(row: typeof emailTokens.$inferSelect): EmailTokenRow {
  return { ...row, purpose: row.purpose as EmailTokenPurpose };
}

export interface ReplaceEmailTokenInput {
  /** Chosen by the caller: the code HMAC mixes the row id in, so it must be known before the insert. */
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  targetEmail: string;
  tokenHash: Buffer;
  codeHash: Buffer;
  expiresAt: Date;
  codeExpiresAt: Date;
}

/**
 * Store a new challenge for (user, purpose), replacing the live one: "a new
 * send invalidates the previous token" (§4.1). Serialized per (user,
 * purpose) by a transaction-scoped advisory lock, so two sends racing
 * cannot trip the one-live-row index.
 */
export async function replaceEmailToken(db: DbClient, input: ReplaceEmailTokenInput): Promise<EmailTokenRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lobbyforge:email-token:${input.userId}:${input.purpose}`}))`);
    await tx
      .delete(emailTokens)
      .where(and(eq(emailTokens.userId, input.userId), eq(emailTokens.purpose, input.purpose), isNull(emailTokens.consumedAt)));
    const [row] = await tx
      .insert(emailTokens)
      .values({
        id: input.id,
        userId: input.userId,
        purpose: input.purpose,
        targetEmail: input.targetEmail,
        tokenHash: input.tokenHash,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        codeExpiresAt: input.codeExpiresAt,
      })
      .returning();
    if (!row) throw new Error('replaceEmailToken: insert returned no rows');
    return toTokenRow(row);
  });
}

/** The live (unconsumed) challenge for (user, purpose), expired or not; null when there is none. */
export async function getActiveEmailToken(
  db: DbClient,
  userId: string,
  purpose: EmailTokenPurpose
): Promise<EmailTokenRow | null> {
  const [row] = await db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.consumedAt)))
    .limit(1);
  return row ? toTokenRow(row) : null;
}

/** A challenge by its link-token hash (consumed or not); null when unknown. */
export async function getEmailTokenByHash(db: DbClient, tokenHash: Buffer): Promise<EmailTokenRow | null> {
  const [row] = await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, tokenHash)).limit(1);
  return row ? toTokenRow(row) : null;
}

/**
 * Reserve one code attempt BEFORE the code is compared: counts it while the
 * challenge is live, its code window open and the count under `maxAttempts`.
 * Returns the challenge with the attempt counted, or null when no attempt is
 * left (consumed, replaced, expired or at the cap) — so N concurrent guesses
 * get at most `maxAttempts` comparisons between them.
 */
export async function reserveEmailCodeAttempt(db: DbClient, tokenId: string, maxAttempts: number): Promise<EmailTokenRow | null> {
  const [row] = await db
    .update(emailTokens)
    .set({ codeAttempts: sql`${emailTokens.codeAttempts} + 1` })
    .where(
      and(
        eq(emailTokens.id, tokenId),
        isNull(emailTokens.consumedAt),
        lt(emailTokens.codeAttempts, maxAttempts),
        gt(emailTokens.codeExpiresAt, sql`now()`),
        gt(emailTokens.expiresAt, sql`now()`)
      )
    )
    .returning();
  return row ? toTokenRow(row) : null;
}

/** Drop the account's live challenges of these purposes (pass the transaction to make it part of a write). */
async function dropLiveChallenges(executor: Executor, userId: string, purposes: EmailTokenPurpose[]): Promise<void> {
  await executor
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.consumedAt), inArray(emailTokens.purpose, purposes)));
}

/**
 * Drop the account's live challenges of these purposes. A password or
 * address write drops its own inside its transaction; this is for callers
 * outside one.
 */
export async function revokeEmailChallenges(db: DbClient, userId: string, purposes: EmailTokenPurpose[]): Promise<void> {
  await dropLiveChallenges(db, userId, purposes);
}

/**
 * How a challenge is presented: the link (valid until `expires_at`) or the
 * code (valid until `code_expires_at`; its attempt was reserved first, so
 * the count may be AT the cap here, never over it).
 */
export type EmailTokenProof =
  | { kind: 'link'; tokenId: string }
  | { kind: 'code'; tokenId: string; maxAttempts: number };

/** The one conditional UPDATE that consumes a challenge. Null when it was not live (or not of this purpose). */
async function consume(executor: Executor, purpose: EmailTokenPurpose, proof: EmailTokenProof): Promise<EmailTokenRow | null> {
  const conditions = [
    eq(emailTokens.id, proof.tokenId),
    eq(emailTokens.purpose, purpose),
    isNull(emailTokens.consumedAt),
    gt(emailTokens.expiresAt, sql`now()`),
  ];
  if (proof.kind === 'code') {
    conditions.push(gt(emailTokens.codeExpiresAt, sql`now()`), lte(emailTokens.codeAttempts, proof.maxAttempts));
  }
  const [row] = await executor
    .update(emailTokens)
    .set({ consumedAt: sql`now()` })
    .where(and(...conditions))
    .returning();
  return row ? toTokenRow(row) : null;
}

export type EmailTokenFailure = 'gone' | 'user_gone' | 'email_mismatch' | 'email_taken';

export type ApplyEmailVerificationResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: Extract<EmailTokenFailure, 'gone' | 'email_mismatch'> };

/**
 * Consume a `verify` challenge and mark the account verified — only when its
 * address is still the one the challenge was sent to. A challenge for an
 * address the account no longer has is consumed and verifies nothing.
 */
export async function applyEmailVerification(db: DbClient, proof: EmailTokenProof): Promise<ApplyEmailVerificationResult> {
  return db.transaction(async (tx) => {
    const token = await consume(tx, 'verify', proof);
    if (!token) return { ok: false as const, reason: 'gone' as const };
    const [user] = await tx
      .update(users)
      .set({ emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())` })
      .where(and(eq(users.id, token.userId), eq(users.email, token.targetEmail), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (!user) return { ok: false as const, reason: 'email_mismatch' as const };
    return { ok: true as const, userId: token.userId, email: token.targetEmail };
  });
}

class RollbackWith extends Error {
  constructor(readonly reason: EmailTokenFailure) {
    super(reason);
    this.name = 'RollbackWith';
  }
}

export type ApplyEmailChangeResult =
  | { ok: true; userId: string; oldEmail: string | null; newEmail: string }
  | { ok: false; reason: Extract<EmailTokenFailure, 'gone' | 'user_gone' | 'email_taken'> };

/**
 * Consume a `change` challenge and move the account to the new address,
 * verified (§4.3). The address must still be free when the change is
 * applied: if another account took it meanwhile, nothing changes (the
 * challenge is not consumed either) and the answer is `email_taken`.
 */
export async function applyEmailChange(db: DbClient, proof: EmailTokenProof): Promise<ApplyEmailChangeResult> {
  try {
    return await db.transaction(async (tx) => {
      const token = await consume(tx, 'change', proof);
      if (!token) return { ok: false as const, reason: 'gone' as const };
      const [current] = await tx
        .select({ email: users.email, deletedAt: users.deletedAt, isGuest: users.isGuest })
        .from(users)
        .where(eq(users.id, token.userId))
        .limit(1)
        .for('update');
      if (!current || current.deletedAt || current.isGuest) throw new RollbackWith('user_gone');
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, token.targetEmail), ne(users.id, token.userId)))
        .limit(1);
      if (taken) throw new RollbackWith('email_taken');
      await tx
        .update(users)
        .set({ email: token.targetEmail, emailVerifiedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(users.id, token.userId));
      // Sent to the old address: a reset or verification for it must not outlive the change.
      await dropLiveChallenges(tx, token.userId, ['reset', 'verify']);
      return { ok: true as const, userId: token.userId, oldEmail: current.email, newEmail: token.targetEmail };
    });
  } catch (error) {
    if (error instanceof RollbackWith) return { ok: false, reason: error.reason as 'user_gone' | 'email_taken' };
    // Two changes racing for one address: the unique index decides.
    if (isPgUniqueViolation(error)) return { ok: false, reason: 'email_taken' };
    throw error;
  }
}

export type ApplyPasswordResetResult =
  | { ok: true; userId: string; email: string | null; emailVerified: boolean }
  | { ok: false; reason: Extract<EmailTokenFailure, 'gone' | 'user_gone' | 'email_mismatch'> };

/**
 * Consume a `reset` challenge and set the new password hash — only while
 * the account's address is still the one the challenge was sent to (else
 * nothing changes: `email_mismatch`). A successful reset also proves the
 * address (§4.1), so the account is marked verified, and every other live
 * `change` and `reset` challenge of the account is dropped in the same
 * transaction. The caller then revokes every session (the password-change
 * machinery).
 */
export async function applyPasswordReset(
  db: DbClient,
  proof: EmailTokenProof,
  newPasswordHash: string
): Promise<ApplyPasswordResetResult> {
  try {
    return await db.transaction(async (tx) => {
      const token = await consume(tx, 'reset', proof);
      if (!token) return { ok: false as const, reason: 'gone' as const };
      const [account] = await tx
        .select({ email: users.email, deletedAt: users.deletedAt, isGuest: users.isGuest })
        .from(users)
        .where(eq(users.id, token.userId))
        .limit(1)
        .for('update');
      if (!account || account.deletedAt || account.isGuest) throw new RollbackWith('user_gone');
      if (account.email !== token.targetEmail) throw new RollbackWith('email_mismatch');
      const [user] = await tx
        .update(users)
        .set({ passwordHash: newPasswordHash, emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`, updatedAt: sql`now()` })
        .where(and(eq(users.id, token.userId), eq(users.email, token.targetEmail), isNull(users.deletedAt), eq(users.isGuest, false)))
        .returning({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt });
      if (!user) throw new RollbackWith('user_gone');
      await dropLiveChallenges(tx, user.id, ['change', 'reset']);
      return { ok: true as const, userId: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null };
    });
  } catch (error) {
    if (error instanceof RollbackWith) return { ok: false, reason: error.reason === 'email_mismatch' ? 'email_mismatch' : 'user_gone' };
    throw error;
  }
}

/** Housekeeping: drop challenges that expired or were consumed before `before`. Returns the number removed. */
export async function deleteStaleEmailTokens(db: DbClient, before: Date): Promise<number> {
  const removed = await db
    .delete(emailTokens)
    .where(or(lt(emailTokens.expiresAt, before), lt(emailTokens.consumedAt, before)))
    .returning({ id: emailTokens.id });
  return removed.length;
}

// ---- the account side -------------------------------------------------------

/** What the verification rules need to know about an account (§4.2). */
export interface UserEmailState {
  id: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  isGuest: boolean;
  locale: string;
  displayName: string;
  createdAt: Date;
  deletedAt: Date | null;
  hasPassword: boolean;
  /** How the account was created; null for an account from before 0046. */
  signupChannel: SignupChannel | null;
}

export type SignupChannel = 'open' | 'invite' | 'oauth' | 'setup';
export const SIGNUP_CHANNELS: readonly SignupChannel[] = ['open', 'invite', 'oauth', 'setup'];

type EmailStateRow = Omit<UserEmailState, 'hasPassword' | 'signupChannel'> & { hasPassword: unknown; signupChannel: string | null };

function toEmailState(row: EmailStateRow): UserEmailState {
  return {
    ...row,
    hasPassword: Boolean(row.hasPassword),
    signupChannel: (SIGNUP_CHANNELS as readonly string[]).includes(row.signupChannel ?? '') ? (row.signupChannel as SignupChannel) : null,
  };
}

const emailStateColumns = {
  id: users.id,
  email: users.email,
  emailVerifiedAt: users.emailVerifiedAt,
  isGuest: users.isGuest,
  locale: users.locale,
  displayName: users.displayName,
  createdAt: users.createdAt,
  deletedAt: users.deletedAt,
  hasPassword: sql<boolean>`(${users.passwordHash} IS NOT NULL)`,
  signupChannel: users.signupChannel,
};

export async function getUserEmailState(db: DbClient, userId: string): Promise<UserEmailState | null> {
  const [row] = await db.select(emailStateColumns).from(users).where(eq(users.id, userId)).limit(1);
  return row ? toEmailState(row) : null;
}

/** The account that owns `email` (already normalised to lower case); null when none does. */
export async function getUserEmailStateByEmail(db: DbClient, email: string): Promise<UserEmailState | null> {
  const [row] = await db.select(emailStateColumns).from(users).where(eq(users.email, email)).limit(1);
  return row ? toEmailState(row) : null;
}

/** Does another account hold this address? */
export async function isEmailTaken(db: DbClient, email: string, exceptUserId?: string): Promise<boolean> {
  const condition = exceptUserId ? and(eq(users.email, email), ne(users.id, exceptUserId)) : eq(users.email, email);
  const [row] = await db.select({ id: users.id }).from(users).where(condition).limit(1);
  return Boolean(row);
}

/**
 * Mark an account verified (a Google sign-in that says so, or an admin).
 * Keeps an earlier timestamp. Returns false when there is no such
 * (undeleted) account.
 */
export async function markUserEmailVerified(db: DbClient, userId: string): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())` })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  return Boolean(row);
}

/**
 * Mark an account verified because a third party (Google) vouched for
 * `email` — only when that is the address the account has. False otherwise
 * (an account without an address, as Google sign-ups are, is never marked).
 */
export async function markUserEmailVerifiedForAddress(db: DbClient, userId: string, email: string): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())` })
    .where(and(eq(users.id, userId), eq(users.email, email.trim().toLowerCase()), isNull(users.deletedAt)))
    .returning({ id: users.id });
  return Boolean(row);
}

export type ChangeUserEmailDirectResult = { ok: true } | { ok: false; reason: 'email_taken' | 'user_gone' };

/**
 * Change the address without proof — only when the instance sends no mail
 * at all (verification `off`, no transport; §4.3). The new address is not
 * verified, so `email_verified_at` is cleared, and every live challenge of
 * the account (sent to the old address, or a change this one supersedes) is
 * dropped in the same transaction.
 */
export async function changeUserEmailDirect(
  db: DbClient,
  userId: string,
  newEmail: string
): Promise<ChangeUserEmailDirectResult> {
  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, newEmail), ne(users.id, userId)))
        .limit(1);
      if (taken) return { ok: false as const, reason: 'email_taken' as const };
      const [row] = await tx
        .update(users)
        .set({ email: newEmail, emailVerifiedAt: null, updatedAt: sql`now()` })
        .where(and(eq(users.id, userId), isNull(users.deletedAt), eq(users.isGuest, false)))
        .returning({ id: users.id });
      if (!row) return { ok: false as const, reason: 'user_gone' as const };
      await dropLiveChallenges(tx, userId, ['reset', 'verify', 'change']);
      return { ok: true as const };
    });
  } catch (error) {
    if (isPgUniqueViolation(error)) return { ok: false, reason: 'email_taken' };
    throw error;
  }
}

export interface UserEmailVerificationSummary {
  userId: string;
  hasEmail: boolean;
  isGuest: boolean;
  emailVerifiedAt: Date | null;
}

/** The verification state of several accounts at once (the admin members list). Never returns the addresses. */
export async function listUserEmailVerification(db: DbClient, userIds: readonly string[]): Promise<UserEmailVerificationSummary[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      userId: users.id,
      hasEmail: sql<boolean>`(${users.email} IS NOT NULL)`,
      isGuest: users.isGuest,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  return rows.map((row) => ({ ...row, hasEmail: Boolean(row.hasEmail) }));
}
