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
import { instanceSettings, servers, users } from '../schema.js';

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

/** Instance-wide stored image bytes, by owner kind. */
export interface InstanceStoredImageBytes {
  totalBytes: number;
  /** Avatars + profile banners of every account, guests included. */
  userBytes: number;
  /** The part of `userBytes` that belongs to guest accounts. */
  guestBytes: number;
  /** Server banners. */
  serverBytes: number;
  /** The instance logo. */
  logoBytes: number;
}

/** octet_length of a nullable column, 0 when null. */
function lengthOf(column: AnyColumn) {
  return sql`coalesce(octet_length(${column}), 0)`;
}

/**
 * security-review FILE-001: how many image bytes the whole instance keeps
 * in Postgres, for the Doctor's `image_storage` check (an instance-wide
 * view the per-user quota does not give). Every stored value counts — a
 * legacy https URL is a few dozen bytes. `octet_length` reads each TOAST
 * value's stored size without loading it (no LIKE here, which would), so
 * this is one pass over the row headers, not over the images.
 */
export async function getInstanceStoredImageBytes(db: DbClient): Promise<InstanceStoredImageBytes> {
  const userSum = sql`${lengthOf(users.avatarUrl)} + ${lengthOf(users.bannerUrl)}`;
  const [userRow] = await db
    .select({
      all: sql<number>`coalesce(sum(${userSum}), 0)::bigint`,
      guests: sql<number>`coalesce(sum(${userSum}) filter (where ${users.isGuest}), 0)::bigint`,
    })
    .from(users);
  const [serverRow] = await db
    .select({ banners: sql<number>`coalesce(sum(${lengthOf(servers.bannerUrl)}), 0)::bigint` })
    .from(servers);
  const [logoRow] = await db
    .select({ logo: sql<number>`coalesce(sum(${lengthOf(instanceSettings.instanceLogoUrl)}), 0)::bigint` })
    .from(instanceSettings);
  const userBytes = Number(userRow?.all ?? 0);
  const guestBytes = Number(userRow?.guests ?? 0);
  const serverBytes = Number(serverRow?.banners ?? 0);
  const logoBytes = Number(logoRow?.logo ?? 0);
  return { totalBytes: userBytes + serverBytes + logoBytes, userBytes, guestBytes, serverBytes, logoBytes };
}
