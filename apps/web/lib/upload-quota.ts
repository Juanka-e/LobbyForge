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
import { getUserStoredImageBytes, USER_IMAGE_QUOTA_BYTES } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

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
