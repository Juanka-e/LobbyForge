import { NextResponse } from 'next/server';
import {
  getServerById,
  isServerMember,
  listCardPackSummaries,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { ensureBuiltInContentSeeded } from '@/lib/plugin-content-seeder';
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

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
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
  return { ok: true, uid: session.uid };
}

function toJson(row: Awaited<ReturnType<typeof listCardPackSummaries>>[number]) {
  return {
    id: row.id,
    pluginId: row.pluginId,
    slug: row.slug,
    name: row.name,
    language: row.language,
    description: row.description,
    isBuiltIn: row.isBuiltIn,
    cardCount: row.cardCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const url = new URL(req.url);
    const pluginId = url.searchParams.get('pluginId') ?? undefined;
    // First request after a fresh install: ensure the bundled Hushle
    // packs exist. Idempotent and module-cached — only the first
    // concurrent caller pays the cost.
    await ensureBuiltInContentSeeded(getDb());
    const rows = await listCardPackSummaries(getDb(), pluginId);
    return NextResponse.json(
      { cardPacks: rows.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list card packs' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'card-packs-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
