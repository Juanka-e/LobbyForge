/**
 * SEC-010: per-user image storage quota, enforced BEFORE persisting.
 *
 * Every image upload endpoint validates the per-request size, but the
 * database stores data URLs — without an aggregate check one account
 * could pin unbounded bytes by rotating avatars/banners. This gate sums
 * the user's currently stored images (see @lobbyforge/db uploadQuota)
 * and rejects an upload that would blow the budget.
 */
import { NextResponse } from 'next/server';
import { getUserById, getUserStoredImageBytes, USER_IMAGE_QUOTA_BYTES } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

/** The machine reason the settings UI translates for a refused guest upload. */
export const GUEST_UPLOAD_FORBIDDEN = 'guest_upload_forbidden';

/**
 * security-review FILE-001: guests may not store images. A guest identity
 * costs nothing (10 new ones an hour per address behind ALTCHA; in
 * invite-only mode an invite is not consumed by a guest), and each could
 * keep ~14 MiB of avatar + banner under its own quota — the per-user quota
 * does not bound how many guests there are. Avatars and banners are for
 * accounts. Null when the user may upload; the 403 otherwise. A missing
 * row is left to the write that follows (it fails on its own).
 */
export async function refuseGuestImageUpload(userId: string): Promise<NextResponse | null> {
  const user = await getUserById(getDb(), userId);
  if (!user?.isGuest) return null;
  return NextResponse.json(
    {
      error: 'Guest accounts cannot upload images. Create an account to add an avatar or banner.',
      code: GUEST_UPLOAD_FORBIDDEN,
    },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}

export interface QuotaDecision {
  ok: boolean;
  /** Bytes already stored under this user's name. */
  usedBytes: number;
  /** The quota ceiling (exported for responses/UI). */
  quotaBytes: number;
}

/**
 * Check whether storing `incomingBytes` more keeps the user within
 * quota. `incomingBytes` should be the FULL data URL length (the stored
 * value), not the decoded image size.
 */
export async function checkUserImageQuota(
  userId: string,
  incomingBytes: number
): Promise<QuotaDecision> {
  const usedBytes = await getUserStoredImageBytes(getDb(), userId);
  return {
    ok: usedBytes + incomingBytes <= USER_IMAGE_QUOTA_BYTES,
    usedBytes,
    quotaBytes: USER_IMAGE_QUOTA_BYTES,
  };
}

/** 413 response carrying the numbers so the UI can explain the limit. */
export function quotaExceededResponse(decision: QuotaDecision): NextResponse {
  return NextResponse.json(
    {
      error: 'Image storage quota exceeded. Remove an existing image before uploading a new one.',
      usedBytes: decision.usedBytes,
      quotaBytes: decision.quotaBytes,
    },
    { status: 413 }
  );
}
