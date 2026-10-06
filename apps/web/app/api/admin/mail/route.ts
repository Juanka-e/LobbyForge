import { NextResponse } from 'next/server';
import { getInstanceBootstrapStatus, logAction } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { AdminMailUpdateSchema, applyAdminMailUpdate, buildAdminMailView } from '@/lib/mail/admin';
import { resolveMailSettings } from '@/lib/mail/settings';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Admin → Settings → Email (docs/EMAIL.md §5). Instance owner only (the
 * same gate as every /api/admin route). The SMTP password is write-only:
 * the answer carries `passwordSet` and `passwordHint`.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const view = await buildAdminMailView(await resolveMailSettings({ fresh: true }));
  return NextResponse.json(view, { headers: NO_STORE });
}

function actorUserId(req: Request): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  // Null for the emergency admin token: there is no account behind it.
  return readGuestSession(req.headers.get('cookie'), secret)?.uid ?? null;
}

async function handlePut(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const parsed = AdminMailUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Paths and messages only — never the submitted values (a password).
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return NextResponse.json({ error: 'invalid_settings', issues }, { status: 400, headers: NO_STORE });
  }
  const result = await applyAdminMailUpdate(parsed.data);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });

  if (result.changedFields.length > 0) {
    try {
      // Filed under the instance's community (the first server), like the
      // other instance settings; field names only, never values.
      const setup = await getInstanceBootstrapStatus(getDb());
      await logAction(getDb(), {
        serverId: setup.firstServerId ?? null,
        actorUserId: actorUserId(req),
        action: 'instance.mail_updated',
        targetType: 'instance',
        targetId: setup.instanceId,
        metadata: { fields: result.changedFields },
      });
    } catch (error) {
      console.error('[admin/mail] audit log write failed', JSON.stringify((error as Error).message));
    }
  }
  return NextResponse.json(result.view, { headers: NO_STORE });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-mail-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const PUT = withApiSecurity(handlePut, {
  allowedMethods: ['PUT'],
  // Room for the disposable allow / block lists.
  maxBodyBytes: 64 * 1024,
  rateLimit: { identifier: 'admin-mail-put', config: { windowMs: 60_000, maxRequests: 10 } },
});
