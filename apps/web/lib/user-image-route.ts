/**
 * GET /api/users/{userId}/avatar and /banner — the decoded image bytes.
 *
 * security-review FILE-001: lists (lobby members, DM list, block list)
 * used to inline every member's data URL (up to ~12 MB avatar + ~16 MB
 * banner each) into every response. They now carry a short reference and
 * the browser fetches each image once from here, cached per version.
 *
 * Who may read (security-review AUTHZ-005):
 *   - a signed-in session is required (a materialized user; guests have
 *     one). Avatars and banners are only rendered inside signed-in
 *     surfaces — lobby, DMs, settings, admin. No signed-out page (hub,
 *     landing, marketplace, invite) shows a user's image, so there is no
 *     public case to support;
 *   - then the owner's "Profile visibility" decides (`canViewProfile`):
 *     everyone → any session; server members → viewers sharing a server;
 *     nobody → the owner only. Owners/moderators get no bypass.
 * A denied, deleted, missing or unservable image is a plain 404, so the
 * route does not reveal whether a hidden image exists.
 *
 * Caching: `private` — the answer depends on the viewer, so a shared
 * cache must never store it. A request whose `?v=` matches the current
 * version is immutable for a year (a new image gets a new version);
 * anything else is cached briefly. The version comes from the user's
 * `avatar_version` / `banner_version` (`userImageRefSql`), which only an
 * image write moves — so a status or bio edit leaves cached images valid
 * instead of forcing every viewer to re-download them (FILE-001).
 */
import { NextResponse } from 'next/server';
import { getUserImageAccess, getUserImageData, type UserImageKind } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { decodeImageDataUrl, IMAGE_FORMAT_MIME } from '@/lib/image-validation';
import { canViewProfile } from '@/lib/profile-privacy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USER_IMAGE_IMMUTABLE_CACHE = 'private, max-age=31536000, immutable';
export const USER_IMAGE_SHORT_CACHE = 'private, max-age=300';

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export async function handleUserImageGet(
  req: Request,
  ctx: { params: Promise<{ userId: string }> },
  kind: UserImageKind
): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const { userId } = await ctx.params;
  if (!UUID_RE.test(userId)) return notFound();
  const viewerUserId = session.session.uid;

  try {
    const db = getDb();
    // Authorize BEFORE reading the image: a denied request never pulls
    // a multi-MB value out of Postgres.
    const access = await getUserImageAccess(db, { userId, viewerUserId, kind });
    if (!access || !access.hasImage) return notFound();
    const allowed = canViewProfile(access.profileVisibility, {
      isSelf: viewerUserId === userId,
      sharesServer: access.sharesServer,
    });
    if (!allowed) return notFound();

    const data = await getUserImageData(db, userId, kind);
    if (!data) return notFound();
    // Legacy https values are linked directly by the lists; only stored
    // PNG/JPEG/GIF/WebP data URLs (content-sniffed) are served here.
    const image = decodeImageDataUrl(data.value);
    if (!image) return notFound();

    const requestedVersion = new URL(req.url).searchParams.get('v');
    const immutable = requestedVersion !== null && data.ref !== null && requestedVersion === data.ref;
    // A view over the decoded Buffer — no second multi-MB copy.
    const body = new Uint8Array(image.bytes.buffer as ArrayBuffer, image.bytes.byteOffset, image.bytes.byteLength);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': IMAGE_FORMAT_MIME[image.format],
        'Content-Length': String(image.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        // Opened directly, the response is a sandboxed document that can
        // load and run nothing.
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': immutable ? USER_IMAGE_IMMUTABLE_CACHE : USER_IMAGE_SHORT_CACHE,
      },
    });
  } catch (err) {
    console.error(`[users/${kind}] failed:`, (err as Error).name || 'UnknownError');
    return NextResponse.json({ error: 'Failed to load image' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
