/**
 * Permission helpers for the web app's API routes.
 *
 * The route layer leans on `hasPermission` from `@lobbyforge/core` to gate
 * "can the caller do X on server Y". This module wraps the lookup so the
 * routes have a single, predictable error response: 403 with
 * `{ error: 'Forbidden' }`.
 *
 * The "owner always has ADMINISTRATOR" rule is handled in the DB helper
 * `getUserPermissions` in `packages/db/src/queries/roles.ts`, so the route
 * doesn't need to know about it. A freshly created server's owner has
 * `ADMINISTRATOR` immediately, and `hasPermission(perms, anything)`
 * short-circuits to true for them.
 */
import { NextResponse } from 'next/server';
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';
import { getDb } from '@/lib/db';
import { canMemberAccessChannel, getUserPermissions } from '@lobbyforge/db';

export type AuthorizeResult =
  | { ok: true; permissions: string[] }
  | { ok: false; response: NextResponse };

/**
 * Verify the caller is a member of the server AND has the required
 * permission. Returns the granted permissions on success (so the caller
 * can avoid a second lookup if it needs more than the boolean).
 */
export async function authorizeServerPermission(
  userId: string,
  serverId: string,
  required: CorePermissionT
): Promise<AuthorizeResult> {
  if (!userId || !serverId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'User id and server id are required' },
        { status: 400 }
      ),
    };
  }

  const permissions = await getUserPermissions(getDb(), userId, serverId);
  if (permissions.length === 0) {
    // Empty permissions means the user is not a member of the server.
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  if (!hasPermission(permissions, required)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { ok: true, permissions };
}

// Re-export the permission constants so the route files can pull them
// from a single import.
export { CorePermission, hasPermission };

/**
 * Role-gated channel visibility (0028): can this member access the
 * channel? Owner and MANAGE_CHANNELS (administrator short-circuits it)
 * always pass; everyone else needs an empty override set or a listed
 * role. Use in every channel-scoped content route.
 */
export async function authorizeChannelVisibility(
  userId: string,
  serverId: string,
  channelId: string,
  ownerUserId: string | null
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (ownerUserId && ownerUserId === userId) return { ok: true };
  const permissions = await getUserPermissions(getDb(), userId, serverId);
  if (hasPermission(permissions, CorePermission.MANAGE_CHANNELS)) {
    return { ok: true };
  }
  const allowed = await canMemberAccessChannel(getDb(), serverId, channelId, userId);
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'You do not have access to this channel' }, { status: 403 }),
    };
  }
  return { ok: true };
}
