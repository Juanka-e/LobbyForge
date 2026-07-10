import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserBanner } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

const BannerPayloadSchema = z.object({
  dataUrl: z
    .string()
    .min(64, 'Banner data is too small.')
    .max(MAX_DATA_URL_BYTES, 'Banner data is too large (max 8 MB).')
    .refine(
      (value) => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
      'Banner must be a base64 PNG, JPEG, or WebP image data URL.'
    )
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
