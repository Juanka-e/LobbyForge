import { NextResponse } from 'next/server';
import { getServerById, isServerMember, type ServerRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function toJson(server: ServerRow): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    ownerUserId: server.ownerUserId,
    iconUrl: server.iconUrl,
    defaultLocale: server.defaultLocale,
    isPublic: server.isPublic,
    createdAt: server.createdAt.toISOString(),
    deletedAt: server.deletedAt?.toISOString() ?? null,
  };
}

async function handler(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
  }

  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!session.uid) {
    return NextResponse.json(
      { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
      { status: 503 }
    );
  }

  let server: ServerRow | null;
  try {
    server = await getServerById(getDb(), id);
  } catch {
    return NextResponse.json(
      { error: 'Failed to load server' },
      { status: 500 }
    );
  }
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  // M11: any member of the server can read it (not just the owner).
  // Owners are auto-added as members by createServer, so the owner check
  // is implicit in the membership lookup.
  let isMember = false;
  try {
    isMember = await isServerMember(getDb(), session.uid, server.id);
  } catch {
    return NextResponse.json(
      { error: 'Failed to check membership' },
      { status: 500 }
    );
  }
  if (!isMember) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ server: toJson(server) }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(handler, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'servers-get-one', config: { windowMs: 60_000, maxRequests: 60 } },
});
