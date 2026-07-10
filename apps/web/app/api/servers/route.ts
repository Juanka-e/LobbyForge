import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServerNameSchema, SlugSchema } from '@lobbyforge/core';
import { createServer, listServersForUser, type ServerRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { isOfficialDeployment } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

const CreateServerSchema = z.object({
  name: ServerNameSchema,
  slug: SlugSchema.optional(),
  isPublic: z.boolean().optional(),
  defaultLocale: z.string().min(2).max(8).optional(),
});

async function handleGet(req: Request): Promise<NextResponse> {
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

  let servers: ServerRow[];
  try {
    servers = await listServersForUser(getDb(), session.uid, { limit: 100 });
  } catch (err) {
    console.error('[servers] list failed', err);
    return NextResponse.json({ error: 'Failed to list servers' }, { status: 500 });
  }

  return NextResponse.json(
    { servers: servers.map(toJson) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function handlePost(req: Request): Promise<NextResponse> {
  if (!isOfficialDeployment()) {
    return NextResponse.json(
      { error: 'Instance creation is available only on the official hub' },
      { status: 403 }
    );
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

  let body: z.infer<typeof CreateServerSchema>;
  try {
    const raw = await req.json();
    body = CreateServerSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const created = await createServer(getDb(), {
      name: body.name,
      slug: body.slug ?? null,
      isPublic: body.isPublic ?? false,
      defaultLocale: body.defaultLocale ?? 'en',
      ownerUserId: session.uid,
    });
    return NextResponse.json(
      { server: toJson(created) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[servers] create failed', err);
    return NextResponse.json({ error: 'Failed to create server' }, { status: 500 });
  }
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

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'servers-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'servers-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
