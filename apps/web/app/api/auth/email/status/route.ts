import { NextResponse } from 'next/server';
import { requireMaterializedSession } from '@/lib/api-auth';
import { emailStatusFor } from '@/lib/mail/status';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/auth/email/status (docs/EMAIL.md §4.3) — the signed-in
 * account's address and verification state, for the banner, the code entry
 * and the settings section:
 *
 *   { email, verified, mode, restricted, pendingChange, resendAvailableAt, mailConfigured }
 *
 * Built by `emailStatusFor` (lib/mail/status.ts), the same builder the
 * pages use for the banner's first paint.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const status = await emailStatusFor(session.session.uid);
  if (!status) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: NO_STORE });
  return NextResponse.json(status, { headers: NO_STORE });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'auth-email-status', config: { windowMs: 60_000, maxRequests: 120 } },
});
