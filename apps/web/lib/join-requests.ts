/**
 * The join approval queue — what the API routes share
 * (`/api/servers/{id}/join-requests/**`).
 *
 * Who may review requests: KICK_MEMBERS or MANAGE_SERVER (ADMINISTRATOR
 * implies both).
 *   - KICK_MEMBERS is the existing "who stays in this community" right:
 *     the moderators who remove members are the ones who vet arrivals
 *     (Discord's join applications are reviewed with the same right).
 *   - MANAGE_SERVER holders set the access policy that creates the queue;
 *     they could switch approval off and let anyone in, so reviewing
 *     grants them nothing new.
 * BAN_MEMBERS / MODERATE_MEMBERS alone do not admit people.
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import type { JoinRequestListItem, JoinRequestRow } from '@lobbyforge/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server and request ids are UUIDs: anything else is answered 404 by the
 * routes BEFORE it reaches Postgres (which would throw on the cast → 500).
 */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function canReviewJoinRequests(permissions: string[]): boolean {
  return (
    hasPermission(permissions, CorePermission.KICK_MEMBERS) ||
    hasPermission(permissions, CorePermission.MANAGE_SERVER)
  );
}

export interface JoinRequestJson {
  id: string;
  serverId: string;
  userId: string;
  displayName: string;
  isGuest: boolean;
  accountCreatedAt: string;
  source: 'invite' | 'auto_join';
  /** Only for MANAGE_SERVER holders (beta-review F7: others never see other members' invite codes). */
  inviteCode: string | null;
  inviterName: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string | null } | null;
}

export function toJoinRequestJson(
  row: JoinRequestListItem,
  options: { includeInviteCode: boolean }
): JoinRequestJson {
  return {
    id: row.id,
    serverId: row.serverId,
    userId: row.userId,
    displayName: row.displayName,
    isGuest: row.isGuest,
    accountCreatedAt: row.accountCreatedAt.toISOString(),
    source: row.source,
    inviteCode: options.includeInviteCode ? row.inviteCode : null,
    inviterName: row.inviterName,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy ? { id: row.decidedBy, name: row.decidedByName } : null,
  };
}

/** The decision a moderator just made, without the requester's profile fields. */
export function toDecisionJson(row: JoinRequestRow) {
  return {
    id: row.id,
    serverId: row.serverId,
    userId: row.userId,
    status: row.status,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy,
  };
}
