import { NextResponse } from 'next/server';
import { getInstanceBootstrapStatus, logAction } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { AdminCaptchaUpdateSchema, applyAdminCaptchaUpdate, buildAdminCaptchaView } from '@/lib/captcha/admin';
import { resolveCaptchaSettings } from '@/lib/captcha/settings';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Admin → Settings → Authentication → Bot protection (docs/CAPTCHA.md §6.1).
 * Instance owner only (the same gate as every /api/admin route). The secret
 * key is write-only: the answer carries `secretSet` and `secretHint`.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const view = await buildAdminCaptchaView(await resolveCaptchaSettings({ fresh: true }));
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
  const parsed = AdminCaptchaUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Paths and messages only — never the submitted values (a secret).
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return NextResponse.json({ error: 'invalid_settings', issues }, { status: 400, headers: NO_STORE });
  }
  const result = await applyAdminCaptchaUpdate(parsed.data);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });

  if (result.changedFields.length > 0) {
    try {
      // Instance-wide settings are filed under the instance's community (the
      // first server), so they show up in its audit log; field names only.
      const setup = await getInstanceBootstrapStatus(getDb());
      await logAction(getDb(), {
        serverId: setup.firstServerId ?? null,
        actorUserId: actorUserId(req),
        action: 'instance.captcha_updated',
        targetType: 'instance',
        targetId: setup.instanceId,
        metadata: { fields: result.changedFields },
      });
    } catch (error) {
      console.error('[admin/captcha] audit log write failed', (error as Error).message);
    }
  }
  return NextResponse.json(result.view, { headers: NO_STORE });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-captcha-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const PUT = withApiSecurity(handlePut, {
  allowedMethods: ['PUT'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'admin-captcha-put', config: { windowMs: 60_000, maxRequests: 10 } },
});
