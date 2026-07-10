import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getEffectiveInstanceAccessSettings,
  setInstanceAccessSettings,
} from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SettingsSchema = z.object({
  registrationMode: z.enum(['open', 'invite_only', 'closed']),
  guestAccessEnabled: z.boolean(),
  seoIndexingEnabled: z.boolean(),
  seoTitle: z.string().trim().max(70).nullable().optional(),
  seoDescription: z.string().trim().max(160).nullable().optional(),
}).strict();

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;
  const settings = await getEffectiveInstanceAccessSettings(getDb());
  return NextResponse.json({ settings }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;
  const parsed = SettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid instance settings.' }, { status: 400 });
  }
  const settings = await setInstanceAccessSettings(getDb(), parsed.data);
  return NextResponse.json({ settings }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-instance-settings-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'admin-instance-settings-patch', config: { windowMs: 60_000, maxRequests: 10 } },
});
