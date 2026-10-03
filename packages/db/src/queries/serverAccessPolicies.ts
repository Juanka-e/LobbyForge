import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverAccessPolicies, servers } from '../schema.js';

export type JoinPolicy = 'invite_only' | 'public_with_approval' | 'public_self_register' | 'guest_allowed';
export type ExternalIdentityPolicy = 'off' | 'allow_lobbyforge' | 'require_lobbyforge_for_registry';
export type LocalAccountPolicy = 'allow_local_email_password' | 'existing_local_users_only' | 'guest_only_invites';
export type AccountLinkingPolicy = 'allow_link' | 'auto_create_from_lobbyforge' | 'require_admin_approval_first_join';

export interface ServerAccessPolicyRow {
  id: string;
  serverId: string;
  joinPolicy: JoinPolicy;
  externalIdentity: ExternalIdentityPolicy;
  localAccount: LocalAccountPolicy;
  accountLinking: AccountLinkingPolicy;
  requireApprovalForFirstJoin: boolean;
  updatedAt: Date;
}

export interface UpsertServerAccessPolicyInput {
  serverId: string;
  joinPolicy?: JoinPolicy;
  externalIdentity?: ExternalIdentityPolicy;
  localAccount?: LocalAccountPolicy;
  accountLinking?: AccountLinkingPolicy;
  requireApprovalForFirstJoin?: boolean;
}

/**
 * The policy of a server that has NO saved row — and what such a server
 * actually enforces. Registration (`serverPolicyRegistrationRefusal`) only
 * applies a saved row, so a server without one has never added a gate of
 * its own on top of the instance's registration mode: invite-less sign-up
 * works whenever the instance is open. `joinPolicy` used to read
 * 'invite_only' here, so the settings page showed "Invite only" for that
 * open server, and saving the values it showed started refusing invite-less
 * registration. 'public_self_register' is the value that matches the
 * enforcement; saving the displayed defaults changes nothing.
 */
export const DEFAULT_SERVER_ACCESS_POLICY = {
  joinPolicy: 'public_self_register',
  externalIdentity: 'off',
  localAccount: 'allow_local_email_password',
  accountLinking: 'allow_link',
  requireApprovalForFirstJoin: false,
} as const;

export async function getServerAccessPolicy(
  db: DbClient,
  serverId: string
): Promise<ServerAccessPolicyRow | null> {
  const [row] = await db
    .select()
    .from(serverAccessPolicies)
    .where(eq(serverAccessPolicies.serverId, serverId))
    .limit(1);
  return (row as ServerAccessPolicyRow | undefined) ?? null;
}

/**
 * security-review AUTHZ-004: does this policy hold a newcomer for
 * moderator approval? Invite redeem and the /lobby auto-join then file a
 * join request (`server_join_requests`, see `queries/joinRequests.ts`)
 * instead of creating a membership; registration refuses (an account is
 * not created for a join that may be rejected). Registration reads the
 * policy through `serverPolicyRegistrationRefusal`, which calls this —
 * the two cannot drift.
 */
export function accessPolicyRequiresApproval(
  policy: Pick<ServerAccessPolicyRow, 'joinPolicy' | 'accountLinking' | 'requireApprovalForFirstJoin'> | null | undefined
): boolean {
  if (!policy) return false;
  return (
    policy.requireApprovalForFirstJoin ||
    policy.joinPolicy === 'public_with_approval' ||
    policy.accountLinking === 'require_admin_approval_first_join'
  );
}

/**
 * security-review AUTHZ-004: must `userId` go through the approval queue
 * to become a NEW member of the server? True when the server's policy asks
 * for approval — except for the owner, who is never held out of their own
 * server. Callers check this only when they are about to INSERT a
 * membership (an existing member is not re-approved).
 */
export async function isNewMemberApprovalRequired(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<boolean> {
  const [server] = await db
    .select({ ownerUserId: servers.ownerUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server?.ownerUserId === userId) return false;
  return accessPolicyRequiresApproval(await getServerAccessPolicy(db, serverId));
}

/** Why a server's saved access policy refuses a local registration, or null when it does not. */
export type RegistrationPolicyRefusal = 'local_accounts_disabled' | 'approval_required' | 'invite_required';

/**
 * The server-level part of `POST /api/auth/register` (the instance's
 * registration mode is checked before it). `policy` is the SAVED row —
 * null when there is none, which refuses nothing. A row holding exactly
 * DEFAULT_SERVER_ACCESS_POLICY refuses nothing either, so "save the values
 * the settings page shows for a server without a row" leaves registration
 * as it was.
 */
export function serverPolicyRegistrationRefusal(
  policy: Pick<ServerAccessPolicyRow, 'joinPolicy' | 'localAccount' | 'accountLinking' | 'requireApprovalForFirstJoin'> | null | undefined,
  input: { hasInvite: boolean }
): RegistrationPolicyRefusal | null {
  if (!policy) return null;
  if (policy.localAccount !== 'allow_local_email_password') return 'local_accounts_disabled';
  if (accessPolicyRequiresApproval(policy)) return 'approval_required';
  if (!input.hasInvite && policy.joinPolicy !== 'public_self_register') return 'invite_required';
  return null;
}

export async function getEffectiveServerAccessPolicy(
  db: DbClient,
  serverId: string
): Promise<ServerAccessPolicyRow | (typeof DEFAULT_SERVER_ACCESS_POLICY & { serverId: string; id: null; updatedAt: null })> {
  const existing = await getServerAccessPolicy(db, serverId);
  return existing ?? {
    id: null,
    serverId,
    updatedAt: null,
    ...DEFAULT_SERVER_ACCESS_POLICY,
  };
}

export async function upsertServerAccessPolicy(
  db: DbClient,
  input: UpsertServerAccessPolicyInput
): Promise<ServerAccessPolicyRow> {
  const existing = await getServerAccessPolicy(db, input.serverId);
  const values = {
    joinPolicy: input.joinPolicy,
    externalIdentity: input.externalIdentity,
    localAccount: input.localAccount,
    accountLinking: input.accountLinking,
    requireApprovalForFirstJoin: input.requireApprovalForFirstJoin,
    updatedAt: new Date(),
  };

  if (existing) {
    const [row] = await db
      .update(serverAccessPolicies)
      .set(values)
      .where(eq(serverAccessPolicies.id, existing.id))
      .returning();
    if (!row) throw new Error('upsertServerAccessPolicy: update returned no rows');
    return row as ServerAccessPolicyRow;
  }

  const [row] = await db
    .insert(serverAccessPolicies)
    .values({
      serverId: input.serverId,
      joinPolicy: input.joinPolicy ?? DEFAULT_SERVER_ACCESS_POLICY.joinPolicy,
      externalIdentity: input.externalIdentity ?? DEFAULT_SERVER_ACCESS_POLICY.externalIdentity,
      localAccount: input.localAccount ?? DEFAULT_SERVER_ACCESS_POLICY.localAccount,
      accountLinking: input.accountLinking ?? DEFAULT_SERVER_ACCESS_POLICY.accountLinking,
      requireApprovalForFirstJoin:
        input.requireApprovalForFirstJoin ?? DEFAULT_SERVER_ACCESS_POLICY.requireApprovalForFirstJoin,
    })
    .returning();
  if (!row) throw new Error('upsertServerAccessPolicy: insert returned no rows');
  return row as ServerAccessPolicyRow;
}
