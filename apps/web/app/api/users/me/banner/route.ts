import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserBanner } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { BANNER_LIMITS, checkImageDataUrl } from '@/lib/image-validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

const BannerPayloadSchema = z.object({
  // Structural check here; content-sniffed format (GIF now included) and
  // dimension enforcement live in checkImageDataUrl.
  dataUrl: z
    .string()
    .min(64, 'Banner data is too small.')
    .max(BANNER_LIMITS.maxDataUrlBytes, 'Banner data is too large (max 8 MB).')
    .nullable(),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof BannerPayloadSchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = BannerPayloadSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid banner payload' }, { status: 400 });
  }

  if (body.dataUrl !== null) {
    // GIF87a/GIF89a accepted (animated banners); min 960×540, max 4096.
    const check = checkImageDataUrl(body.dataUrl, BANNER_LIMITS);
    if (!check.ok) {
      return NextResponse.json({ error: check.error ?? 'Invalid banner image.' }, { status: 400 });
    }
  }

  const updated = await updateUserBanner(getDb(), session.session.uid, body.dataUrl);
  return NextResponse.json(
    { bannerUrl: updated.bannerUrl },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: MAX_DATA_URL_BYTES + 1024,
  rateLimit: { identifier: 'user-banner-post', config: { windowMs: 60_000, maxRequests: 8 } },
});
