import { NextResponse } from 'next/server';
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';
import { getChannelById, getServerById, getUserPermissions, isServerMember } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession, type GuestPayload } from '@/lib/guest-session';

export type ApiSession = GuestPayload & { uid: string };

export type ApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; response: NextResponse };

export function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

export function requireMaterializedSession(req: Request): ApiResult<{ session: ApiSession }> {
  const session = readGuestSession(req.headers.get('cookie'), getSessionSecret());
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, session: session as ApiSession };
}

export async function requireServerMember(
  userId: string,
  serverId: string
): Promise<ApiResult<{ server: Awaited<ReturnType<typeof getServerById>> }>> {
  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  if (server.ownerUserId !== userId && !(await isServerMember(getDb(), userId, serverId))) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, server };
}

export async function requireChannelInServer(
  channelId: string,
  serverId: string
): Promise<ApiResult<{ channel: NonNullable<Awaited<ReturnType<typeof getChannelById>>> }>> {
  const channel = await getChannelById(getDb(), channelId);
  if (!channel || channel.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found in this server' }, { status: 404 }) };
  }
  return { ok: true, channel };
}

export async function requireServerPermission(
  userId: string,
  serverId: string,
  required: CorePermissionT
): Promise<ApiResult<{ permissions: string[] }>> {
  const permissions = await getUserPermissions(getDb(), userId, serverId);
  if (!hasPermission(permissions, required)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, permissions };
}

export { CorePermission, hasPermission };
