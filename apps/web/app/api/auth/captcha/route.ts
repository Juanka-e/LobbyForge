import { NextResponse } from 'next/server';
import { buildPublicCaptchaConfig } from '@/lib/captcha/guard';
import { CONFIG_LIMIT, hitAddressLimit } from '@/lib/captcha/limits';
import { isCaptchaSurface } from '@/lib/captcha/types';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bot protection — the public config of one surface (docs/CAPTCHA.md §4.1):
 * whether the challenge is required now, which provider the client must
 * render (ALTCHA while an external provider's breaker is open), its site
 * key and display options, and the `formToken` of the minimum-fill-time
 * check. Never a secret.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const surface = new URL(req.url).searchParams.get('surface');
  if (!isCaptchaSurface(surface)) {
    return NextResponse.json({ error: 'invalid_surface' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  // 120 / min per address, or a 1200 / min instance-wide backstop when client
  // addresses are unknown (no trusted proxy).
  const limited = await hitAddressLimit(req, CONFIG_LIMIT);
  if (limited) return limited;
  const config = await buildPublicCaptchaConfig(surface);
  return NextResponse.json(config, { headers: { 'Cache-Control': 'no-store' } });
}

// The sign-in, sign-up and invite pages read it on load. Rate limited in
// the handler (CONFIG_LIMIT), which knows what to do with unknown addresses.
export const GET = withApiSecurity(handleGet, { allowedMethods: ['GET'] });
