import { NextResponse } from 'next/server';
import { sanitizeOAuthRedirect } from '@/lib/oauth-redirect';
import { withApiSecurity } from '@/lib/security-headers';
import { exchangeGoogleCode, isGoogleOAuthConfigured } from '@/lib/oauth-google';
import {
  getIdentityLinkByProviderSubject,
  createUserIdentityLink,
  touchUserIdentityLink,
  listUserIdentityLinks,
} from '@lobbyforge/db';
import { findOrCreateGuestUser } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { buildGuestSessionCookie, createGuestIdentity, GUEST_SESSION_TTL_SECONDS } from '@/lib/guest-session';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { authorizeGuestRegistration } from '@/lib/instance-access';
import { recordSession } from '@/lib/session-tracker';
import { timingSafeEqual } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/oauth/google/callback — Google redirects here after consent.
 * Exchanges the code, verifies the ID token, and creates/links the account.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.redirect(new URL('/login?error=oauth_not_configured', req.url));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, req.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL('/login?error=missing_params', req.url));
  }

  // Verify state against the cookie (CSRF protection).
  const cookieState = req.headers.get('cookie')
    ?.match(/lf_oauth_state=([a-f0-9]+)/)?.[1];
  // Length guard before timingSafeEqual to prevent RangeError on mismatched lengths.
  const stateBuf = Buffer.from(state);
  const cookieBuf = cookieState ? Buffer.from(cookieState) : Buffer.alloc(0);
  if (!cookieState || stateBuf.length !== cookieBuf.length || !timingSafeEqual(stateBuf, cookieBuf)) {
    return NextResponse.redirect(new URL('/login?error=state_mismatch', req.url));
  }

  // SEC-005: the cookie is client-writable storage — sanitize on read,
  // not just on write (a tampered lf_oauth_redirect must not become an
  // open redirect at `new URL(redirect, req.url)`).
  const redirect = sanitizeOAuthRedirect(
    req.headers.get('cookie')?.match(/lf_oauth_redirect=([^;]+)/)?.[1] ?? null
  );

  try {
    // Exchange code → verify ID token → get Google user info.
    const googleUser = await exchangeGoogleCode(code);

    const db = getDb();

    // Check if this Google account is already linked.
    let link = await getIdentityLinkByProviderSubject(db, 'google', googleUser.sub);

    let userId: string;
    if (link) {
      // Existing link — update lastUsedAt.
      await touchUserIdentityLink(db, link.id);
      userId = link.userId;
    } else {
      // beta-review: account CREATION via Google ignored the instance
      // access policy — a `closed` or `invite_only` self-host (or one
      // with guest access disabled; OAuth accounts are guest rows) still
      // got a brand-new account + session from any Google login. Apply
      // the same policy POST /api/auth/guest applies to a new identity;
      // this flow carries no invite code, so invite-only instances
      // refuse new OAuth accounts. Already-linked accounts (above) are
      // unaffected. The official hub keeps open OAuth sign-up (it has no
      // instance registration policy of its own, like /register).
      if (!isOfficialDeployment()) {
        const access = await authorizeGuestRegistration(db, {});
        if (!access.ok) {
          const res = NextResponse.redirect(new URL('/login?error=registration_closed', req.url));
          res.cookies.delete('lf_oauth_state');
          res.cookies.delete('lf_oauth_redirect');
          return res;
        }
      }

      // No link yet — create a new user (or find by email).
      const user = await findOrCreateGuestUser(db, {
        guestKey: `google:${googleUser.sub}`,
        displayName: googleUser.name,
      });
      if (!user) throw new Error('Failed to create user from Google OAuth');
      userId = user.id;

      // Link the Google identity.
      link = await createUserIdentityLink(db, {
        userId,
        provider: 'google',
        providerSubject: googleUser.sub,
        providerEmail: googleUser.email,
        emailVerified: googleUser.emailVerified,
        claims: { name: googleUser.name, picture: googleUser.picture },
      });
    }

    // Issue a session cookie for the resolved user.
    const identity = createGuestIdentity();
    identity.uid = userId;
    identity.name = googleUser.name;
    const secret = process.env.LOBBYFORGE_SESSION_SECRET!;
    const signed = buildGuestSessionCookie(identity, secret, {
      secure: process.env.NODE_ENV === 'production',
    });
    // beta-review (S7): record the session BEFORE handing out the cookie
    // — `revokeOtherSessions` (password change) can only revoke sessions
    // it can list, and OAuth sign-ins were never recorded. An unrecorded
    // session could never be revoked, so production fails closed (same
    // stance as the security-headers revocation check); dev only logs.
    try {
      await recordSession(userId, identity.gid, req);
    } catch (trackErr) {
      console.error('[oauth/google/callback] session tracking failed:', (trackErr as Error).message);
      if (process.env.NODE_ENV === 'production') {
        const res = NextResponse.redirect(new URL('/login?error=session_unavailable', req.url));
        res.cookies.delete('lf_oauth_state');
        res.cookies.delete('lf_oauth_redirect');
        return res;
      }
    }

    // Clear OAuth cookies + redirect to the app.
    // Use signed.setCookieHeader verbatim — buildGuestSessionCookie already
    // emits a fully-formed Set-Cookie with Path, Max-Age, HttpOnly, SameSite, Secure.
    // beta-review: `res.cookies.delete()` re-serializes EVERY Set-Cookie
    // header from its own cookie bag, which wiped a session cookie set
    // beforehand via headers.set() — OAuth sign-in never delivered its
    // session. Delete first, then APPEND the session cookie.
    const res = NextResponse.redirect(new URL(redirect, req.url));
    res.cookies.delete('lf_oauth_state');
    res.cookies.delete('lf_oauth_redirect');
    res.headers.append('Set-Cookie', signed.setCookieHeader);
    return res;
  } catch (err) {
    console.error('[oauth/google/callback] failed:', (err as Error).message);
    return NextResponse.redirect(new URL('/login?error=oauth_failed', req.url));
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'oauth-google-callback', config: { windowMs: 60_000, maxRequests: 10 } },
});
