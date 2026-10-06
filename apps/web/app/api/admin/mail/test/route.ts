import { NextResponse } from 'next/server';
import { getUserEmailState } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { AdminMailTestSchema, testMailConfiguration } from '@/lib/mail/admin';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

async function adminEmail(req: Request): Promise<string | null> {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const uid = readGuestSession(req.headers.get('cookie'), secret)?.uid;
  if (!uid) return null;
  return (await getUserEmailState(getDb(), uid).catch(() => null))?.email ?? null;
}

/**
 * Email → "Send a test email" (docs/EMAIL.md §5): `{ to?, ...unsaved
 * overrides }`. Connects, authenticates and sends the `test` template; the
 * default recipient is the admin's own address. Answers
 * `{ result, detail? }` — `detail` is a code, never the server's text. The
 * result is recorded as the last test only when no override was given.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const parsed = AdminMailTestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return NextResponse.json({ error: 'invalid_settings', issues }, { status: 400, headers: NO_STORE });
  }
  const result = await testMailConfiguration(parsed.data, await adminEmail(req));
  if (!result.ok) return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  return NextResponse.json(result.outcome, { headers: NO_STORE });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  // Each test is an outgoing SMTP connection (and an email).
  rateLimit: { identifier: 'admin-mail-test', config: { windowMs: 60_000, maxRequests: 10 } },
});
