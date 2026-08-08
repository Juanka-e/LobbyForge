/**
 * Invite queries — thin wrappers over the Drizzle client.
 *
 * An "invite" is a server-scoped shareable code that lets a user join the
 * server. The code is a 12-character Crockford-base32 string (10^18
 * combinations; collisions handled by a unique-index on `invites.code`).
 * A redeem atomically checks `expiresAt` + `maxUses`, increments
 * `currentUses`, and inserts a `memberships` row assigned to the server's
 * `@everyone` role.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbClient } from '../client.js';
import { invites, membershipRoles, memberships, roles, serverBans, servers } from '../schema.js';
import { EVERYONE_ROLE_NAME } from './roles.js';

export interface InviteRow {
  id: string;
  serverId: string;
  createdBy: string | null;
  code: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface InviteMetadata {
  code: string;
  serverId: string;
  serverName: string;
  expiresAt: Date | null;
  currentUses: number;
  maxUses: number | null;
  isExpired: boolean;
  isExhausted: boolean;
}

export interface CreateInviteInput {
  serverId: string;
  createdBy: string;
  maxUses?: number | null;
  expiresAt?: Date | null;
}

/**
 * Crockford's base32 alphabet, minus `U` (excluded by spec to avoid
 * accidental obscenities) and minus `0`/`O`/`1`/`I`/`L` (visually
 * ambiguous). 27 characters × 12 positions ≈ 1.5 × 10^17.
 */
const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateInviteCode(length: number = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/**
 * Create a new invite. The code is generated locally (not from a sequence)
 * and validated by a unique index on `invites.code` — a duplicate insert
 * is retried with a fresh code up to 5 times before we give up.
 */
export async function createInvite(
  db: DbClient,
  input: CreateInviteInput
): Promise<InviteRow> {
  // Verify the server exists (not soft-deleted) before we insert.
  const server = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, input.serverId), isNull(servers.deletedAt)))
    .limit(1);
  if (server.length === 0) {
    throw new Error(`createInvite: server ${input.serverId} does not exist`);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      const [row] = await db
        .insert(invites)
        .values({
          serverId: input.serverId,
          createdBy: input.createdBy,
          code,
          maxUses: input.maxUses ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error('createInvite: insert returned no rows');
      return row as InviteRow;
    } catch (err) {
      // Postgres unique violation → retry with a fresh code.
      const isUniqueViolation =
        err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505';
      if (!isUniqueViolation) throw err;
    }
  }
  throw new Error('createInvite: failed to generate a unique code after 5 attempts');
}

export async function getInviteById(db: DbClient, inviteId: string): Promise<InviteRow | null> {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.id, inviteId))
    .limit(1);
  return (rows[0] as InviteRow | undefined) ?? null;
}

export async function getInviteByCode(db: DbClient, code: string): Promise<InviteRow | null> {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);
  return (rows[0] as InviteRow | undefined) ?? null;
}

/**
 * List invites for a server, newest first. The route layer is responsible
 * for the membership / permission check; this helper only filters out
 * invites whose parent server is soft-deleted.
 */
export async function listInvitesForServer(db: DbClient, serverId: string): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: invites.id,
      serverId: invites.serverId,
      createdBy: invites.createdBy,
      code: invites.code,
      maxUses: invites.maxUses,
      currentUses: invites.currentUses,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .innerJoin(servers, eq(servers.id, invites.serverId))
    .where(and(eq(invites.serverId, serverId), isNull(servers.deletedAt)))
    .orderBy(sql`${invites.createdAt} DESC`);
  return rows as InviteRow[];
}

/**
 * Public invite metadata (no PII). Used by the join page before the user
 * has accepted. Joins the server to surface the server's display name.
 */
export async function getInviteMetadata(db: DbClient, code: string): Promise<InviteMetadata | null> {
  const rows = await db
    .select({
      code: invites.code,
      serverId: invites.serverId,
      serverName: servers.name,
      expiresAt: invites.expiresAt,
      currentUses: invites.currentUses,
      maxUses: invites.maxUses,
    })
    .from(invites)
    .innerJoin(servers, eq(servers.id, invites.serverId))
    .where(and(eq(invites.code, code), isNull(servers.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  return {
    code: row.code,
    serverId: row.serverId,
    serverName: row.serverName,
    expiresAt: row.expiresAt,
    currentUses: row.currentUses,
    maxUses: row.maxUses,
    isExpired: row.expiresAt ? row.expiresAt.getTime() < now : false,
    isExhausted: row.maxUses !== null && row.currentUses >= row.maxUses,
  };
}

/**
 * Hard-delete an invite. Returns true if a row was deleted.
 */
export async function revokeInvite(db: DbClient, inviteId: string): Promise<boolean> {
  const result = await db
    .delete(invites)
    .where(eq(invites.id, inviteId))
    .returning({ id: invites.id });
  return result.length > 0;
}

/**
 * Reason a redeem failed. The route layer maps this to a status code:
 *   - `not_found` → 404
 *   - `expired` / `exhausted` → 410
 *   - `already_member` → 409
 */
export type RedeemInviteError =
  | 'not_found'
  | 'expired'
  | 'exhausted'
  | 'already_member'
  | 'no_everyone_role'
  | 'banned';

export type RedeemInviteResult =
  | { ok: true; membershipId: string; serverId: string; roleId: string }
  | { ok: false; error: RedeemInviteError };

/**
 * Atomically redeem an invite. The whole flow runs inside a Drizzle
 * transaction so two concurrent redeems can't both push `currentUses`
 * past `maxUses`:
 *   1. Lock the invite row.
 *   2. Verify the user is not already a member.
 *   3. Verify `expiresAt` + `currentUses < maxUses`.
 *   4. Look up the server's `@everyone` role.
 *   5. Insert the `memberships` row with `roleId = @everyone.id`.
 *   6. Increment `currentUses`.
 *
 * Returns a discriminated-union result so the route layer can map errors
 * to status codes without parsing strings.
 */
export async function redeemInvite(
  db: DbClient,
  code: string,
  userId: string
): Promise<RedeemInviteResult> {
  return db.transaction(async (tx) => {
    // 1. Lock the invite row.
    const inviteRows = await tx.execute<{
      id: string;
      server_id: string;
      max_uses: number | null;
      current_uses: number;
      expires_at: Date | null;
    }>(sql`
      SELECT id, server_id, max_uses, current_uses, expires_at
      FROM ${invites}
      WHERE code = ${code}
      FOR UPDATE
    `);
    type LockedInvite = {
      id: string;
      server_id: string;
      max_uses: number | null;
      current_uses: number;
      expires_at: Date | null;
    };
    const normalizedRows = Array.isArray(inviteRows)
      ? inviteRows as unknown as LockedInvite[]
      : (inviteRows as unknown as { rows?: LockedInvite[] }).rows ?? [];
    const invite = normalizedRows[0];
    if (!invite) {
      return { ok: false as const, error: 'not_found' as RedeemInviteError };
    }

    // 2. Already a member?
    const existingMember = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.serverId, invite.server_id)))
      .limit(1);
    if (existingMember.length > 0) {
      return { ok: false as const, error: 'already_member' as RedeemInviteError };
    }

    // 2b. Banned? A ban with a past `expiresAt` is treated as not-banned;
    //     the row sticks around as an audit artifact but the read path
    //     ignores it. The UI surfaces "you were banned from this server"
    //     with a 403-ish status.
    const banRows = await tx
      .select({ expiresAt: serverBans.expiresAt })
      .from(serverBans)
      .where(
        and(eq(serverBans.serverId, invite.server_id), eq(serverBans.userId, userId))
      )
      .limit(1);
    if (banRows.length > 0 && (!banRows[0]?.expiresAt || banRows[0].expiresAt.getTime() > Date.now())) {
      return { ok: false as const, error: 'banned' as RedeemInviteError };
    }

    // 3. Expired?
    if (invite.expires_at && invite.expires_at.getTime() < Date.now()) {
      return { ok: false as const, error: 'expired' as RedeemInviteError };
    }
    // Exhausted?
    if (invite.max_uses !== null && invite.current_uses >= invite.max_uses) {
      return { ok: false as const, error: 'exhausted' as RedeemInviteError };
    }

    // 4. Look up the server's @everyone role. The M13 seed runs on
    //    `createServer`; if the role is missing something is very wrong,
    //    so we surface the error to the route layer.
    const everyoneRows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.serverId, invite.server_id), eq(roles.name, EVERYONE_ROLE_NAME)))
      .limit(1);
    const everyoneId = everyoneRows[0]?.id;
    if (!everyoneId) {
      return { ok: false as const, error: 'no_everyone_role' as RedeemInviteError };
    }

    // 5. Insert the membership.
    const [member] = await tx
      .insert(memberships)
      .values({
        serverId: invite.server_id,
        userId,
        roleId: everyoneId,
      })
      .returning({ id: memberships.id });
    if (!member) {
      throw new Error('redeemInvite: insert membership returned no rows');
    }

    // Mirror the role assignment in the membership_roles join table (M15.5)
    await tx.insert(membershipRoles).values({
      membershipId: member.id,
      roleId: everyoneId,
    });

    // 6. Increment currentUses.
    await tx
      .update(invites)
      .set({ currentUses: sql`${invites.currentUses} + 1` })
      .where(eq(invites.id, invite.id));

    return {
      ok: true as const,
      membershipId: member.id,
      serverId: invite.server_id,
      roleId: everyoneId,
    };
  });
}
