/**
 * User image references + profile-visibility inputs for list queries.
 *
 * security-review FILE-001: `users.avatar_url` / `users.banner_url` hold
 * base64 data URLs of up to ~12 / ~16 MB. Every list that selected them
 * (lobby members, DM list, block list) pulled the full strings out of
 * Postgres and shipped them inline to every viewer, so a handful of
 * accounts with big images inflated every /lobby render by hundreds of
 * MB. The storage format stays; lists now select a SHORT reference
 * instead, and the bytes are served by GET /api/users/{id}/{avatar|banner}.
 *
 * security-review AUTHZ-005: the same queries also select the subject's
 * `profileVisibility` (and, where the viewer is not implied by the
 * query, whether the two users share a server) so the web layer can
 * project avatar / banner / bio / status text per viewer.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbClient } from '../client.js';
import { users, userSettings } from '../schema.js';
import { normalizeUserPrivacySettings, type ActivityVisibilityScope } from './userSettings.js';

export type UserImageKind = 'avatar' | 'banner';

/** Length of the version token in an image reference (hex chars). */
export const USER_IMAGE_VERSION_LENGTH = 12;

/** Longest legacy external (https) image URL a reference passes through. */
export const MAX_EXTERNAL_USER_IMAGE_URL_LENGTH = 2048;

/**
 * A short reference to a user image, computed in SQL so the image itself
 * never leaves Postgres:
 *   - `null`               no image, a deleted user, or a value we would not render
 *   - `'https://…'`        a legacy external URL (≤ 2048 chars), passed through
 *   - 12 hex chars         a version token for /api/users/{id}/{kind}?v=<token>
 *
 * security-review FILE-001: the token is md5(<kind>_version, byte length)
 * rather than a hash of the content — `octet_length` and `substr` read the
 * TOAST header / first chunk only, so a member list does not detoast every
 * multi-MB data URL just to version it.
 *
 * It is NOT built from `updated_at`: that moves on every status / bio /
 * name edit, so a member editing their status every few seconds made every
 * viewer re-download (and the server re-decode) their multi-MB image on
 * each lobby load. `avatar_version` / `banner_version` (0041) are bumped by
 * every write of the matching image column and by nothing else
 * (updateUserAvatar / updateUserBanner in users.ts). The byte length stays
 * in the hash as a backstop: a write that bypasses those functions (manual
 * SQL, a restore) still changes the token whenever the size changes.
 *
 * `column` must be `users.avatarUrl` or `users.bannerUrl`, and `users`
 * must be in the FROM clause un-aliased (the token reads the version
 * column and users.deleted_at).
 */
export function userImageRefSql(column: AnyPgColumn): SQL<string | null> {
  const version = imageVersionColumn(column);
  return sql<string | null>`case
    when ${column} is null or ${users.deletedAt} is not null then null
    when substr(${column}, 1, 5) = 'data:' then substr(md5(${version}::text || ':' || octet_length(${column})::text), 1, ${sql.raw(String(USER_IMAGE_VERSION_LENGTH))})
    when substr(${column}, 1, 8) = 'https://' and octet_length(${column}) <= ${sql.raw(String(MAX_EXTERNAL_USER_IMAGE_URL_LENGTH))} then ${column}
    else null
  end`;
}

/** The version column that belongs to an image column (see userImageRefSql). */
function imageVersionColumn(column: AnyPgColumn): AnyPgColumn {
  if (column === users.avatarUrl) return users.avatarVersion;
  if (column === users.bannerUrl) return users.bannerVersion;
  throw new Error('userImageRefSql: column must be users.avatarUrl or users.bannerUrl');
}

/**
 * The subject's raw `privacy.profileVisibility` (null when they never saved
 * settings). Normalize with {@link toProfileVisibility}.
 */
export function profileVisibilitySql(userIdColumn: AnyPgColumn | SQL): SQL<string | null> {
  return sql<string | null>`(select ${userSettings.privacy} ->> 'profileVisibility' from ${userSettings} where ${userSettings.userId} = ${userIdColumn})`;
}

/**
 * True when `viewerUserId` and the subject are both members of at least
 * one live (not soft-deleted) server — the "Server members" visibility
 * scope ("only people who belong to the same community").
 */
export function sharesServerSql(viewerUserId: string, userIdColumn: AnyPgColumn | SQL): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from memberships viewer_m
    join memberships subject_m on subject_m.server_id = viewer_m.server_id
    join servers shared_s on shared_s.id = viewer_m.server_id and shared_s.deleted_at is null
    where viewer_m.user_id = ${viewerUserId} and subject_m.user_id = ${userIdColumn}
  )`;
}

/** Normalize a raw `profileVisibility` value (default: server members). */
export function toProfileVisibility(raw: unknown): ActivityVisibilityScope {
  return normalizeUserPrivacySettings({ profileVisibility: raw }).profileVisibility;
}

function imageColumn(kind: UserImageKind) {
  return kind === 'avatar' ? users.avatarUrl : users.bannerUrl;
}

export interface UserImageAccess {
  /** Whether a value is stored at all (cheap null check, no detoast). */
  hasImage: boolean;
  profileVisibility: ActivityVisibilityScope;
  /** Viewer and subject share at least one server. */
  sharesServer: boolean;
}

/**
 * Everything the image route needs to decide whether `viewerUserId` may
 * read the subject's image — WITHOUT reading the image. Null when the
 * subject does not exist or is soft-deleted.
 */
export async function getUserImageAccess(
  db: DbClient,
  input: { userId: string; viewerUserId: string; kind: UserImageKind }
): Promise<UserImageAccess | null> {
  const column = imageColumn(input.kind);
  const subjectId = sql`${input.userId}::uuid`;
  const rows = await db
    .select({
      hasImage: sql<boolean>`(${column} is not null)`,
      // The subject id as a PARAMETER, not `users.id`: in a single-table
      // select Drizzle renders columns unqualified, so `users.id` became a
      // bare "id" — ambiguous inside the memberships subquery (every image
      // request 500'd) and silently user_settings.id inside the settings
      // subquery (visibility "nobody" would have been ignored).
      profileVisibility: profileVisibilitySql(subjectId),
      sharesServer: sharesServerSql(input.viewerUserId, subjectId),
    })
    .from(users)
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    hasImage: row.hasImage === true,
    profileVisibility: toProfileVisibility(row.profileVisibility),
    sharesServer: row.sharesServer === true,
  };
}

/**
 * The stored image value plus its current reference (same token the list
 * queries hand out), read in ONE statement so the cache decision matches
 * the bytes. Null when there is no image or the user is soft-deleted.
 */
export async function getUserImageData(
  db: DbClient,
  userId: string,
  kind: UserImageKind
): Promise<{ value: string; ref: string | null } | null> {
  const column = imageColumn(kind);
  const rows = await db
    .select({ value: column, ref: userImageRefSql(column) })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.value) return null;
  return { value: row.value, ref: row.ref ?? null };
}
