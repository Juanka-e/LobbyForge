import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DisplayNameSchema } from '@lobbyforge/core';
import { findOrCreateGuestUser } from '@lobbyforge/db';
import {
  buildGuestSessionCookie,
  createGuestIdentity,
  readGuestSession,
} from '@/lib/guest-session';
import { getDb } from '@/lib/db';
import { guardCaptchaSurface } from '@/lib/captcha/guard';
import { NEW_GUEST_LIMIT, hitAddressLimit, peekAddressLimit } from '@/lib/captcha/limits';
import { CaptchaBodyFields } from '@/lib/captcha/types';
import { authorizeGuestRegistration } from '@/lib/instance-access';
import { withApiSecurity } from '@/lib/security-headers';
import { isSessionRevoked, recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GuestRequestSchema = z.object({
  // Optional seed for a reproducible display name. If omitted, a random
  // 4-char suffix is appended to "Guest ".
  displayNameSeed: z.string().max(48).optional(),
  // If true, this is a re-bind of an existing guest (e.g. after refresh).
  // In that case we keep the gid + uid from the cookie and just refresh the name.
  rebind: z.boolean().optional(),
  inviteCode: z.string().length(12).optional(),
  // Bot protection (docs/CAPTCHA.md §4.3) — only looked at when this request
  // would create a NEW guest identity.
  ...CaptchaBodyFields,
}).strict();

/**
 * Phase 0 (docs/CAPTCHA.md §7): NEW guest identities get their own bucket —
 * 10 per hour per client address, or a 200 / hour instance-wide backstop
 * when addresses are unknown (no trusted proxy) — on top of the route's
 * 30/min, which a refresh keeps sharing as before. Checked (without
 * counting) BEFORE the challenge, so a solved token is not spent on a
 * request the limit refuses anyway; counted once the new identity is about
 * to be created, so the `captcha_required` round trip costs nothing.
 * (`lib/captcha/limits.ts`.)
 */

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
  // Security follow-up (absolute lifetime): `readGuestSession` already
  // treats a session older than its absolute lifetime as absent, so an
  // over-age session is never refreshed — the request continues exactly
  // like one without a cookie (a NEW guest identity, if the instance
  // allows guests). A signed-in user signs in again.
  let existing = readGuestSession(req.headers.get('cookie'), secret);
  if (existing?.uid) {
    try {
      if (await isSessionRevoked(existing.uid, existing.gid)) existing = null;
    } catch (err) {
      console.error('[auth/guest] revocation check failed:', (err as Error).message);
      return NextResponse.json({ error: 'Session verification is temporarily unavailable.' }, { status: 503 });
    }
  }
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

  // Bot protection: only a NEW guest identity needs the challenge — a valid
  // guest cookie (refresh, re-bind) never does (docs/CAPTCHA.md §2). The
  // access policy above runs first: a challenge is pointless where guests
  // cannot get in at all, and it is a read, not the row this protects.
  if (!existing) {
    const full = await peekAddressLimit(req, NEW_GUEST_LIMIT);
    if (full) return full;
    const refused = await guardCaptchaSurface(req, body, 'guest');
    if (refused) return refused;
    const limited = await hitAddressLimit(req, NEW_GUEST_LIMIT);
    if (limited) return limited;
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

  // A refresh keeps the session's original `auth_time` (its expiry is
  // capped at auth_time + the absolute lifetime). A legacy cookie without
  // one — and every new session — starts the clock now.
  const signed = buildGuestSessionCookie(identity, secret, {
    secure: process.env.NODE_ENV === 'production',
    authTime: existing?.auth_time,
  });

  // Session fingerprint for the active-sessions feature. beta-review
  // (S7): awaited — this is also the cookie REFRESH path, so it is what
  // keeps every live session listable for `revokeOtherSessions`.
  if (identity.uid) {
    try {
      await recordSession(identity.uid, identity.gid, req, { authTime: signed.payload.auth_time });
    } catch (error) {
      console.error('[auth/guest] session tracking failed:', (error as Error).message);
    }
  }

  return NextResponse.json(
    {
      guest: {
        gid: identity.gid,
        uid: identity.uid,
        name: identity.name,
        // One TTL, or less when the session nears its absolute lifetime.
        ttlSeconds: signed.payload.exp - signed.payload.iat,
      },
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
    const uid = session.uid;
    void (async () => {
      try {
        await recordSession(uid, session.gid, req, { authTime: session.auth_time });
      } catch (error) {
        console.error('[auth/guest] session tracking failed:', (error as Error).message);
      }
    })();
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
  sessionRevocation: 'bypass',
  // Room for a CAPTCHA token (up to 4096 characters).
  maxBodyBytes: 12 * 1024,
  rateLimit: { identifier: 'auth-guest-post', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'auth-guest-get', config: { windowMs: 60_000, maxRequests: 120 } },
});
