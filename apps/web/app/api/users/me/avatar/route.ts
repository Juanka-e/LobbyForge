import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserAvatar } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { AVATAR_LIMITS, checkImageDataUrl } from '@/lib/image-validation';
import { checkUserImageQuota, quotaExceededResponse } from '@/lib/upload-quota';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DATA_URL_BYTES = 6 * 1024 * 1024;

const DataUrlSchema = z.object({
  // Structural check here (shape + total size); the format/dimension
  // defence lives in checkImageDataUrl (content-sniffed, GIF included).
  dataUrl: z
    .string()
    .min(64, 'Avatar data is too small.')
    .max(AVATAR_LIMITS.maxDataUrlBytes, 'Avatar data is too large (max 6 MB).'),
});

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

  // Content-sniffed format + dimension enforcement (PNG/JPEG/GIF/WebP,
  // min 256×256, max 4096) — the UI crops proportionally, the server
  // decides what is acceptable.
  const check = checkImageDataUrl(body.dataUrl, AVATAR_LIMITS);
  if (!check.ok) {
    return NextResponse.json({ error: check.error ?? 'Invalid avatar image.' }, { status: 400 });
  }

  // Production: hand off to object storage / CDN. For this milestone we
  // persist the data URL directly so the round-trip works end-to-end.
  // SEC-010: aggregate per-user image quota (avatar + banners + owned
  // server banners) — the per-request cap alone let one account pin
  // unbounded bytes by rotating uploads.
  const quota = await checkUserImageQuota(session.session.uid, body.dataUrl.length);
  if (!quota.ok) return quotaExceededResponse(quota);

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
