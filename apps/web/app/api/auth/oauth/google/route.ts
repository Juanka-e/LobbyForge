import { NextResponse } from 'next/server';
import { sanitizeOAuthRedirect } from '@/lib/oauth-redirect';
import { withApiSecurity } from '@/lib/security-headers';
import { buildGoogleAuthUrl, isGoogleOAuthConfigured } from '@/lib/oauth-google';
import { randomBytes } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/oauth/google — redirects to Google's consent screen.
 * Generates a state token to prevent CSRF on the callback.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.json({ error: 'Google OAuth is not configured.' }, { status: 503 });
  }

  // Generate a state token and set it as a short-lived cookie.
  const state = randomBytes(32).toString('hex');
  const redirect = sanitizeOAuthRedirect(new URL(req.url).searchParams.get('redirect'));
  const authUrl = buildGoogleAuthUrl(state);

  const res = NextResponse.redirect(authUrl);
  // Store state + redirect target in a short-lived cookie for the callback.
  res.cookies.set('lf_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 300, // 5 minutes
  });
  res.cookies.set('lf_oauth_redirect', redirect, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 300,
  });
  return res;
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'oauth-google-start', config: { windowMs: 60_000, maxRequests: 10 } },
});
