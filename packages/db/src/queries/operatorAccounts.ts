/**
 * Operator account recovery (`lfctl user …`, docs/GUEST_AUTH.md "Account
 * recovery by the server operator").
 *
 * The person with shell access to the server runs these from inside the
 * web container (apps/web/scripts/operator-user.mjs). No HTTP route calls
 * them: the shell is the credential.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { auditLogs, emailTokens, instanceSettings, servers, users } from '../schema.js';
import { DEFAULT_INSTANCE_ID } from './instanceSettings.js';

type Transaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];
type Executor = DbClient | Transaction;

/** The audit action of a password set by the server operator (actor: none, `metadata.actor: "operator"`). */
export const OPERATOR_PASSWORD_RESET_ACTION = 'user.password_reset_by_operator';

export type OperatorPasswordResetFailure = 'not_found' | 'deleted' | 'guest';

export type OperatorPasswordResetResult =
  | { ok: true; userId: string; email: string; displayName: string }
  | { ok: false; reason: OperatorPasswordResetFailure };

/**
 * The server the instance's audit entries are filed under: the owner's
 * oldest live server, where the admin reads the audit log (the admin's
 * "mark verified" files there too). Null before /setup.
 */
async function instanceAuditServerId(executor: Executor, instanceId: string): Promise<string | null> {
  const [settings] = await executor
    .select({ ownerUserId: instanceSettings.ownerUserId })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  if (!settings?.ownerUserId) return null;
  const [server] = await executor
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.ownerUserId, settings.ownerUserId), isNull(servers.deletedAt)))
    .orderBy(asc(servers.createdAt))
    .limit(1);
  return server?.id ?? null;
}

/**
 * Set a new password hash for the account with this email, as the server
 * operator. No current password is asked for (the operator's shell access
 * is the proof), and an account that signs in only with Google gets a
 * password too. In one transaction it also drops the account's live email
 * `change` and `reset` challenges (as a password change does, docs/EMAIL.md
 * §4.1) and writes the audit entry, so a reset never happens unrecorded.
 *
 * It does NOT mark the address verified (the operator proved nothing about
 * the mailbox) and does not touch sessions: the caller revokes every
 * session, the desktop handoff codes and the sign-in lock afterwards (the
 * password-reset machinery in apps/web). Device cookies need nothing: they
 * are bound to the password hash, which just changed.
 */
export async function resetUserPasswordAsOperator(
  db: DbClient,
  input: { email: string; newPasswordHash: string },
  instanceId: string = DEFAULT_INSTANCE_ID
): Promise<OperatorPasswordResetResult> {
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isGuest: users.isGuest,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
      .for('update');
    if (!account?.email) return { ok: false as const, reason: 'not_found' as const };
    if (account.deletedAt) return { ok: false as const, reason: 'deleted' as const };
    if (account.isGuest) return { ok: false as const, reason: 'guest' as const };

    await tx
      .update(users)
      .set({ passwordHash: input.newPasswordHash, updatedAt: new Date() })
      .where(eq(users.id, account.id));
    await tx
      .delete(emailTokens)
      .where(and(
        eq(emailTokens.userId, account.id),
        isNull(emailTokens.consumedAt),
        inArray(emailTokens.purpose, ['change', 'reset'])
      ));
    await tx.insert(auditLogs).values({
      serverId: await instanceAuditServerId(tx, instanceId),
      actorUserId: null,
      action: OPERATOR_PASSWORD_RESET_ACTION,
      targetType: 'user',
      targetId: account.id,
      metadata: { actor: 'operator' },
    });
    return { ok: true as const, userId: account.id, email: account.email, displayName: account.displayName };
  });
}

/** One row of `lfctl user list-admins`: who the account is, never its id or credentials. */
export interface OperatorAdminAccount {
  email: string | null;
  displayName: string;
  /** The instance owner: the account that opens /admin. */
  instanceOwner: boolean;
  /** Names of the live servers this account owns, oldest first. */
  ownedServers: string[];
}

/**
 * The instance owner and the owners of every live server, for an operator
 * who no longer knows which address the admin account uses. Deleted
 * accounts are left out. The instance owner comes first, then the others
 * by display name.
 */
export async function listInstanceAdminAccounts(
  db: DbClient,
  instanceId: string = DEFAULT_INSTANCE_ID
): Promise<OperatorAdminAccount[]> {
  const [settings] = await db
    .select({ ownerUserId: instanceSettings.ownerUserId })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  const ownerUserId = settings?.ownerUserId ?? null;

  const owned = await db
    .select({ ownerUserId: servers.ownerUserId, name: servers.name })
    .from(servers)
    .where(isNull(servers.deletedAt))
    .orderBy(asc(servers.createdAt));

  const serversByOwner = new Map<string, string[]>();
  for (const server of owned) {
    const names = serversByOwner.get(server.ownerUserId) ?? [];
    names.push(server.name);
    serversByOwner.set(server.ownerUserId, names);
  }
  const ids = [...new Set([...(ownerUserId ? [ownerUserId] : []), ...serversByOwner.keys()])];
  if (ids.length === 0) return [];

  const accounts = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)));

  return accounts
    .map((account) => ({
      email: account.email,
      displayName: account.displayName,
      instanceOwner: account.id === ownerUserId,
      ownedServers: serversByOwner.get(account.id) ?? [],
    }))
    .sort((a, b) => {
      if (a.instanceOwner !== b.instanceOwner) return a.instanceOwner ? -1 : 1;
      return a.displayName.localeCompare(b.displayName) || (a.email ?? '').localeCompare(b.email ?? '');
    });
}
