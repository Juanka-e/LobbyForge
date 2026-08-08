/**
 * Google OAuth 2.0 helpers.
 *
 * Uses the authorization code flow:
 *   1. User clicks "Sign in with Google" → redirect to Google consent.
 *   2. Google redirects back to /api/auth/oauth/google/callback?code=xxx.
 *   3. We exchange the code for an ID token, verify it with Google's JWKS,
 *      extract the user's Google sub + email, and link/create a LobbyForge account.
 *
 * Required env vars (official instance only):
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI (e.g. https://app.lobbyforge.dev/api/auth/oauth/google/callback)
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleUserInfo {
  sub: string;          // Google user ID (stable)
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

/** Build the Google consent URL for the authorization code flow. */
export function buildGoogleAuthUrl(state: string): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('Google OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_REDIRECT_URI)');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Exchange the authorization code for tokens and return verified user info. */
export async function exchangeGoogleCode(code: string): Promise<GoogleUserInfo> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google OAuth is not configured');
  }

  // Exchange code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) {
    throw new Error('Google did not return an id_token');
  }

  // Verify the ID token using Google's JWKS (via jose).
  const { jwtVerify, createRemoteJWKSet } = await import('jose');
  const JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const { payload } = await jwtVerify(tokens.id_token, JWKS, {
    issuer: GOOGLE_ISSUER,
    audience: clientId,
  });

  return {
    sub: payload.sub as string,
    email: payload.email as string,
    emailVerified: payload.email_verified === true,
    name: (payload.name as string) ?? (payload.email as string),
    picture: (payload.picture as string) ?? null,
  };
}

/** Check if Google OAuth is configured (env vars present). */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}
