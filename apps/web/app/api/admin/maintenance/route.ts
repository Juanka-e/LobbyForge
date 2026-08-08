import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEffectiveInstanceMaintenance, setInstanceMaintenance } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const MaintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).nullable().optional(),
}).strict();

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;
  const maintenance = await getEffectiveInstanceMaintenance(getDb());
  return NextResponse.json({ maintenance }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  const parsed = MaintenanceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid maintenance settings.' }, { status: 400 });
  }

  const maintenance = await setInstanceMaintenance(getDb(), {
    enabled: parsed.data.enabled,
    message: parsed.data.message ?? null,
  });
  return NextResponse.json({ maintenance }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-maintenance-get', config: { windowMs: 60_000, maxRequests: 20 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'admin-maintenance-patch', config: { windowMs: 60_000, maxRequests: 10 } },
});
