import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DisplayNameSchema } from '@lobbyforge/core';
import { findOrCreateGuestUser } from '@lobbyforge/db';
import {
  buildGuestSessionCookie,
  createGuestIdentity,
  GUEST_SESSION_TTL_SECONDS,
  readGuestSession,
} from '@/lib/guest-session';
import { getDb } from '@/lib/db';
import { authorizeGuestRegistration } from '@/lib/instance-access';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GuestRequestSchema = z.object({
  // Optional seed for a reproducible display name. If omitted, a random
  // 4-char suffix is appended to "Guest ".
  displayNameSeed: z.string().max(48).optional(),
  // If true, this is a re-bind of an existing guest (e.g. after refresh).
  // In that case we keep the gid + uid from the cookie and just refresh the name.
  rebind: z.boolean().optional(),
  inviteCode: z.string().min(6).max(16).optional(),
});

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

async function handlePost(req: Request): Promise<NextResponse> {
  let body: z.infer<typeof GuestRequestSchema>;
  try {
    const raw = await req.json();
    body = GuestRequestSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Reject obviously-bad seeds early so we don't bake garbage into a cookie.
  if (body.displayNameSeed !== undefined) {
    const seedCheck = DisplayNameSchema.safeParse(body.displayNameSeed);
    if (!seedCheck.success) {
      return NextResponse.json({ error: 'Invalid displayNameSeed' }, { status: 400 });
    }
  }

  const secret = getSessionSecret();
  const existing = readGuestSession(req.headers.get('cookie'), secret);
  let access: Awaited<ReturnType<typeof authorizeGuestRegistration>>;
  try {
    access = await authorizeGuestRegistration(getDb(), {
      existingUserId: existing?.uid,
      inviteCode: body.inviteCode,
    });
  } catch (err) {
    console.error('[auth/guest] access policy lookup failed:', (err as Error).message);
    return NextResponse.json({ error: 'Registration policy is temporarily unavailable.' }, { status: 503 });
  }
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let identity = existing
    ? { gid: existing.gid, uid: existing.uid, name: existing.name }
    : createGuestIdentity(body.displayNameSeed);

  // M10: if the cookie has no materialized `uid`, mint a users row keyed
  // by the gid. This is what lets the servers / channels APIs (Phase 2)
  // reference a real users.id. Failures here are non-fatal: the cookie
  // still works for cookie-only endpoints, the user just can't hit
  // /api/servers until the DB is up.
  if (!identity.uid) {
    try {
      const user = await findOrCreateGuestUser(getDb(), {
        guestKey: identity.gid,
        displayName: identity.name,
      });
      if (user) identity = { gid: identity.gid, uid: user.id, name: user.displayName };
    } catch (err) {
      // Surface the failure so admins notice in logs, but don't 500 the
      // whole endpoint — the cookie is still valid for guest-only flows.
      // (Phase 2 routes will return 503 when they need the user record.)
      console.error('[auth/guest] findOrCreateGuestUser failed:', (err as Error).message);
    }
  }

  const signed = buildGuestSessionCookie(identity, secret, { secure: process.env.NODE_ENV === 'production' });

  // Fire-and-forget session fingerprint for the active-sessions feature.
  if (identity.uid) {
    void recordSession(identity.uid, identity.gid, req);
  }

  return NextResponse.json(
    {
      guest: { gid: identity.gid, uid: identity.uid, name: identity.name, ttlSeconds: GUEST_SESSION_TTL_SECONDS },
    },
    {
      status: 200,
      headers: {
        'Set-Cookie': signed.setCookieHeader,
        'Cache-Control': 'no-store',
      },
    }
  );
}

async function handleGet(req: Request): Promise<NextResponse> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return NextResponse.json({ error: 'No active guest session' }, { status: 401 });
  }
  // Fire-and-forget: refresh the session fingerprint on every page-load probe.
  if (session.uid) {
    void recordSession(session.uid, session.gid, req);
  }
  return NextResponse.json(
    {
      guest: { gid: session.gid, uid: session.uid, name: session.name, iat: session.iat, exp: session.exp },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'auth-guest-post', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'auth-guest-get', config: { windowMs: 60_000, maxRequests: 120 } },
});
