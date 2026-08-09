import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserAvatar } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DATA_URL_BYTES = 6 * 1024 * 1024;

const DataUrlSchema = z.object({
  dataUrl: z
    .string()
    .min(64, 'Avatar data is too small.')
    .max(MAX_DATA_URL_BYTES, 'Avatar data is too large (max 6 MB).')
    .refine(
      (value) => /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value),
      'Avatar must be a base64 image data URL.'
    )
    .refine(
      (value) => verifyImageMagicBytes(value),
      'Avatar data does not contain a valid image signature.'
    ),
});

/** Verify the decoded bytes start with a known image magic signature.
 *  Prevents uploading arbitrary data (HTML, executables) disguised as an image. */
function verifyImageMagicBytes(dataUrl: string): boolean {
  try {
    const base64 = dataUrl.split(',')[1];
    if (!base64) return false;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 12) return false;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    // GIF: 47 49 46 38
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
    // WebP: RIFF....WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
    return false;
  } catch {
    return false;
  }
}

async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof DataUrlSchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = DataUrlSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: 'Invalid avatar payload' },
      { status: 400 }
    );
  }

  // Production: hand off to object storage / CDN. For this milestone we
  // persist the data URL directly so the round-trip works end-to-end.
  const updated = await updateUserAvatar(getDb(), session.session.uid, body.dataUrl);
  return NextResponse.json(
    { avatarUrl: updated.avatarUrl },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: MAX_DATA_URL_BYTES + 1024,
  rateLimit: { identifier: 'user-avatar-post', config: { windowMs: 60_000, maxRequests: 10 } },
});
