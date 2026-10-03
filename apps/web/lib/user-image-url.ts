/**
 * URLs for user avatars and banners.
 *
 * security-review FILE-001: images are stored as data URLs of up to
 * ~12 / ~16 MB, and lists used to inline them for every member on every
 * /lobby render. Lists now carry a short reference computed in SQL
 * (`userImageRefSql` in @lobbyforge/db): a version token, or a legacy
 * https URL. This turns that reference into something an <img> can load.
 *
 * Client-safe (no Node imports): the members panel builds the banner URL
 * for the profile popover from the list's `bannerRef` only when it opens.
 */
export type UserImageKind = 'avatar' | 'banner';

/** Version tokens are short lowercase hex (12 chars today). */
const VERSION_RE = /^[0-9a-f]{6,32}$/;

/**
 * Legacy external images: https only, bounded, and nothing that could
 * break out of a CSS `url(...)` or an attribute.
 */
const EXTERNAL_RE = /^https:\/\/[^\s"'()\\<>]+$/;
const MAX_EXTERNAL_LENGTH = 2048;

/** `/api/users/<id>/<kind>?v=<version>` for a version token. */
export function userImagePath(userId: string, kind: UserImageKind, version: string): string {
  return `/api/users/${encodeURIComponent(userId)}/${kind}?v=${encodeURIComponent(version)}`;
}

/**
 * The URL to render for a stored image reference, or null.
 *   - version token → the same-origin image route
 *   - https URL     → passed through unchanged
 *   - anything else (including a `data:` URL that reached here by mistake) → null
 */
export function userImageUrl(
  userId: string,
  kind: UserImageKind,
  ref: string | null | undefined
): string | null {
  if (!ref) return null;
  if (VERSION_RE.test(ref)) return userImagePath(userId, kind, ref);
  if (ref.length <= MAX_EXTERNAL_LENGTH && EXTERNAL_RE.test(ref)) return ref;
  return null;
}
