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
import { eq, sql, type AnyColumn } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { servers, users } from '../schema.js';

/** Total stored-image budget per user (avatar + banners). 24 MiB. */
export const USER_IMAGE_QUOTA_BYTES = 24 * 1024 * 1024;

/**
 * Bytes a stored image value costs this database, measured IN SQL.
 * Only data URLs count — an http(s) URL points at external storage.
 * security-review FILE-001: the old code selected the data URLs (up to
 * ~6 + ~8 MB each, plus every owned server banner) into Node on every
 * upload just to call `.length`; `octet_length` reads the TOAST size
 * instead (data URLs are ASCII, so bytes == characters).
 */
function storedBytesSql(column: AnyColumn) {
  return sql<number>`coalesce(sum(case when ${column} like 'data:%' then octet_length(${column}) else 0 end), 0)::bigint`;
}

/**
 * Sum of image bytes currently attributable to the user: their avatar,
 * their profile banner, and the banners of every server they own.
 */
export async function getUserStoredImageBytes(db: DbClient, userId: string): Promise<number> {
  const [userRow] = await db
    .select({ avatar: storedBytesSql(users.avatarUrl), banner: storedBytesSql(users.bannerUrl) })
    .from(users)
    .where(eq(users.id, userId));

  const [ownedRow] = await db
    .select({ banners: storedBytesSql(servers.bannerUrl) })
    .from(servers)
    .where(eq(servers.ownerUserId, userId));

  return Number(userRow?.avatar ?? 0) + Number(userRow?.banner ?? 0) + Number(ownedRow?.banners ?? 0);
}
