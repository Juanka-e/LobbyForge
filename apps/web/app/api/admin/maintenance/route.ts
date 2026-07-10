import { NextResponse } from 'next/server';
import { getEffectiveInstanceMaintenance, setInstanceMaintenance } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;
  const maintenance = await getEffectiveInstanceMaintenance(getDb());
  return NextResponse.json({ maintenance }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  let body: { enabled?: unknown; message?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled boolean is required.' }, { status: 400 });
  }
  if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
    return NextResponse.json({ error: 'message must be a string.' }, { status: 400 });
  }

  const maintenance = await setInstanceMaintenance(getDb(), {
    enabled: body.enabled,
    message: typeof body.message === 'string' ? body.message : null,
  });
  return NextResponse.json({ maintenance }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-maintenance-get', config: { windowMs: 60_000, maxRequests: 20 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'admin-maintenance-patch', config: { windowMs: 60_000, maxRequests: 10 } },
});
