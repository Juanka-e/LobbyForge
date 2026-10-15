import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateUserBanner } from '@lobbyforge/db';
import { publishProfileChanged } from '@/lib/member-bus';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { BANNER_LIMITS, checkImageDataUrl } from '@/lib/image-validation';
import { checkUserImageQuota, quotaExceededResponse, refuseGuestImageUpload } from '@/lib/upload-quota';
import { consumeUploadBudget } from '@/lib/upload-budget';
import { requireVerifiedEmail } from '@/lib/mail/verification';

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
    // security-review FILE-001: guests may not store images (removing an
    // old banner stays allowed).
    const guest = await refuseGuestImageUpload(session.session.uid);
    if (guest) return guest;
    // docs/EMAIL.md §4.2: an unverified account in `required` mode may not
    // upload an image (an abuse channel); removing the banner stays allowed.
    const unverified = await requireVerifiedEmail(session.session.uid, 'upload');
    if (unverified) return unverified;
    // GIF87a/GIF89a accepted (animated banners); min 960×540, max 4096.
    const check = checkImageDataUrl(body.dataUrl, BANNER_LIMITS);
    if (!check.ok) {
      return NextResponse.json({ error: check.error ?? 'Invalid banner image.' }, { status: 400 });
    }
    // SEC-010: aggregate quota (null = banner REMOVAL, frees budget).
    const quota = await checkUserImageQuota(session.session.uid, body.dataUrl.length);
    if (!quota.ok) return quotaExceededResponse(quota);
    // FILE-001: the caller's daily upload byte budget (per client address).
    const overBudget = await consumeUploadBudget(req, body.dataUrl.length);
    if (overBudget) return overBudget;
  }

  const updated = await updateUserBanner(getDb(), session.session.uid, body.dataUrl);
  // docs/PROFILES.md "Live updates": every community the account is in re-reads it.
  publishProfileChanged(session.session.uid);
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
