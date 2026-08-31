import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstanceSetupStatus, setInstanceLogoUrl } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { LOGO_LIMITS, checkImageDataUrl } from '@/lib/image-validation';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LogoPayloadSchema = z.object({
  // Structural check here; content-sniffed format (GIF included) and
  // dimension enforcement (min 64×64, max 1024) live in checkImageDataUrl.
  dataUrl: z
    .string()
    .min(64, 'Logo data is too small.')
    .max(LOGO_LIMITS.maxDataUrlBytes, 'Logo data is too large (max 2 MB).')
    .nullable(),
});

/**
 * GET — the current instance logo (public: the lobby renders it and the
 * favicon derives from it; no admin needed to READ it).
 */
async function handleGet(): Promise<NextResponse> {
  try {
    const setup = await getInstanceSetupStatus(getDb());
    return NextResponse.json(
      { instanceLogoUrl: setup.instanceLogoUrl },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load instance logo' }, { status: 500 });
  }
}

/**
 * POST — set or clear (null) the instance logo. Instance-owner only
 * (same gate as the other admin instance-settings routes).
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  let body: z.infer<typeof LogoPayloadSchema>;
  try {
    body = LogoPayloadSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid logo payload' }, { status: 400 });
  }

  if (body.dataUrl !== null) {
    const check = checkImageDataUrl(body.dataUrl, LOGO_LIMITS);
    if (!check.ok) {
      return NextResponse.json({ error: check.error ?? 'Invalid logo image.' }, { status: 400 });
    }
  }

  try {
    const logoUrl = await setInstanceLogoUrl(getDb(), body.dataUrl);
    return NextResponse.json(
      { instanceLogoUrl: logoUrl },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[admin/instance-logo] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to update instance logo' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'instance-logo-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: LOGO_LIMITS.maxDataUrlBytes + 1024,
  rateLimit: { identifier: 'instance-logo-post', config: { windowMs: 60_000, maxRequests: 8 } },
});
