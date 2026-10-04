import { NextResponse } from 'next/server';
import { createAltchaChallenge } from '@/lib/captcha/altcha';
import { CHALLENGE_LIMIT, hitAddressLimit } from '@/lib/captcha/limits';
import { resolveCaptchaSettings } from '@/lib/captcha/settings';
import { isCaptchaSurface } from '@/lib/captcha/types';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bot protection — a fresh ALTCHA challenge for one surface
 * (docs/CAPTCHA.md §4.2): the `altcha-lib` v2 challenge
 * `{ parameters, signature }` the `altcha` widget fetches from its
 * `challenge` URL. HMAC-signed; the signed parameters carry the surface and
 * a 5-minute expiry. Served whatever the configured provider is — it is
 * the fallback of an external one.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const surface = new URL(req.url).searchParams.get('surface');
  if (!isCaptchaSurface(surface)) {
    return NextResponse.json({ error: 'invalid_surface' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  // 30 / min per address, or a 600 / min instance-wide backstop when client
  // addresses are unknown (no trusted proxy) — never one tiny shared bucket.
  const limited = await hitAddressLimit(req, CHALLENGE_LIMIT);
  if (limited) return limited;
  const settings = await resolveCaptchaSettings();
  try {
    const challenge = await createAltchaChallenge(surface, settings.options.altchaDifficulty);
    return NextResponse.json(challenge, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[auth/captcha] challenge could not be created', (error as Error).message);
    return NextResponse.json({ error: 'captcha_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

// Each challenge costs one key derivation; a widget fetches one per
// verification (and again after 5 minutes). Rate limited in the handler
// (CHALLENGE_LIMIT), which knows what to do with unknown client addresses.
export const GET = withApiSecurity(handleGet, { allowedMethods: ['GET'] });
