import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstanceBootstrapStatus, logAction, setInstanceDefaultLocale } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getDiscovery } from '@/lib/i18n/catalogue';
import { installedLocale } from '@/lib/i18n/core';
import { getDefaultLocaleAdminView, rememberInstanceDefaultLocale } from '@/lib/i18n/instance-default';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** An installed language's code, or null to clear the saved default (the env, then English, apply). */
const BodySchema = z.object({ locale: z.string().trim().min(2).max(35).nullable() }).strict();

/**
 * Admin → Overview → Default language (docs/TRANSLATING.md). Instance owner
 * only, like every /api/admin route. GET answers every installed language
 * and which step decides the default today (saved here, the env, or
 * English); PUT saves or clears the saved default.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  return NextResponse.json(await getDefaultLocaleAdminView({ fresh: true }), { headers: NO_STORE });
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
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });

  let locale: string | null = null;
  if (parsed.data.locale !== null) {
    locale = installedLocale(parsed.data.locale, getDiscovery().locales.map((l) => l.code));
    if (!locale) return NextResponse.json({ error: 'unknown_locale' }, { status: 400, headers: NO_STORE });
  }

  const { previous, current } = await setInstanceDefaultLocale(getDb(), locale);
  rememberInstanceDefaultLocale(current);

  if (previous !== current) {
    try {
      // Filed under the instance's community (the first server), like the
      // other instance settings.
      const setup = await getInstanceBootstrapStatus(getDb());
      await logAction(getDb(), {
        serverId: setup.firstServerId ?? null,
        actorUserId: actorUserId(req),
        action: 'instance.default_locale_updated',
        targetType: 'instance',
        targetId: setup.instanceId,
        metadata: { from: previous, to: current },
      });
    } catch (error) {
      console.error('[admin/default-locale] audit log write failed', JSON.stringify((error as Error).message));
    }
  }
  return NextResponse.json(await getDefaultLocaleAdminView(), { headers: NO_STORE });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-default-locale-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const PUT = withApiSecurity(handlePut, {
  allowedMethods: ['PUT'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'admin-default-locale-put', config: { windowMs: 60_000, maxRequests: 10 } },
});
