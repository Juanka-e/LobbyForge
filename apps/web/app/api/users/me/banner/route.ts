import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserBanner } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

/** Verify image magic bytes (shared with avatar route). */
function verifyImageMagicBytes(dataUrl: string): boolean {
  try {
    const base64 = dataUrl.split(',')[1];
    if (!base64) return false;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 12) return false;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
    return false;
  } catch {
    return false;
  }
}

const BannerPayloadSchema = z.object({
  dataUrl: z
    .string()
    .min(64, 'Banner data is too small.')
    .max(MAX_DATA_URL_BYTES, 'Banner data is too large (max 8 MB).')
    .refine(
      (value) => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
      'Banner must be a base64 PNG, JPEG, or WebP image data URL.'
    )
    .refine(
      (value) => verifyImageMagicBytes(value),
      'Banner data does not contain a valid image signature.'
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
