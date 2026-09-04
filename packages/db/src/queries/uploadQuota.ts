/**
 * Per-user image storage quota (SEC-010).
 *
 * Images persist as data URLs in Postgres text columns: users.avatarUrl,
 * users.bannerUrl, and servers.bannerUrl for servers the user owns. Each
 * upload endpoint validates a PER-REQUEST size cap, but nothing bounded
 * the TOTAL bytes one account could pin in the database — a scripted
 * account could rotate server banners forever and bloat the DB.
 *
 * This query sums the caller's currently stored image bytes so the API
 * layer can reject an upload that would exceed the quota. The instance
 * logo is admin-only and intentionally uncounted (there is exactly one).
 */
import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { servers, users } from '../schema.js';

/** Total stored-image budget per user (avatar + banners). 24 MiB. */
export const USER_IMAGE_QUOTA_BYTES = 24 * 1024 * 1024;

function storedBytes(value: string | null | undefined): number {
  // Only data URLs count toward the quota — an http(s) URL points at
  // external storage and costs this database nothing.
  if (!value || !value.startsWith('data:')) return 0;
  return value.length;
}

/**
 * Sum of image bytes currently attributable to the user: their avatar,
 * their profile banner, and the banners of every server they own.
 */
export async function getUserStoredImageBytes(db: DbClient, userId: string): Promise<number> {
  const [userRow] = await db
    .select({ avatarUrl: users.avatarUrl, bannerUrl: users.bannerUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  let total = storedBytes(userRow?.avatarUrl) + storedBytes(userRow?.bannerUrl);

  const owned = await db
    .select({ bannerUrl: servers.bannerUrl })
    .from(servers)
    .where(eq(servers.ownerUserId, userId));

  for (const row of owned) total += storedBytes(row.bannerUrl);
  return total;
}
