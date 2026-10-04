import { NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { AdminCaptchaTestSchema, testCaptchaConfiguration } from '@/lib/captcha/admin';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Bot protection → "Test configuration" (docs/CAPTCHA.md §6.1): a dummy
 * siteverify call against the external provider with the given (or saved)
 * keys. Instance owner only; nothing is stored.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const parsed = AdminCaptchaTestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return NextResponse.json({ error: 'invalid_settings', issues }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(await testCaptchaConfiguration(parsed.data), { headers: NO_STORE });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  // Each test is an outgoing request to Cloudflare or Google.
  rateLimit: { identifier: 'admin-captcha-test', config: { windowMs: 60_000, maxRequests: 10 } },
});
