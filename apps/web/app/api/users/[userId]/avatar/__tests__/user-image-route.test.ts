import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

/**
 * security-review FILE-001 / AUTHZ-005: GET /api/users/{id}/avatar|banner
 * serves the decoded bytes of a stored data URL — to signed-in viewers the
 * owner's profile visibility allows — with safe headers and per-version
 * caching. Everything else is a 404.
 */

const getUserImageAccess = vi.fn();
const getUserImageData = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getUserImageAccess, getUserImageData }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const secret = 'x'.repeat(32);
const VIEWER = '00000000-0000-0000-0000-00000000000a';
const OWNER = '00000000-0000-0000-0000-00000000000b';
const VERSION = '0123456789ab';

/** A PNG signature + IHDR chunk (2×2) — enough for the content sniff. */
function pngBytes(): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(2, 16);
  buf.writeUInt32BE(2, 20);
  return buf;
}
const PNG = pngBytes();
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

function cookieFor(uid: string): string {
  return buildGuestSessionCookie({ gid: `g_${'a'.repeat(32)}`, uid, name: 'Viewer' }, secret).setCookieHeader.split(';', 1)[0]!;
}

async function get(
  kind: 'avatar' | 'banner',
  { userId = OWNER, viewer = VIEWER as string | null, query = `?v=${VERSION}` } = {}
) {
  const { GET } =
    kind === 'avatar' ? await import('../route.js') : await import('../../banner/route.js');
  const headers: Record<string, string> = {};
  if (viewer) headers.cookie = cookieFor(viewer);
  return GET(new Request(`https://example.test/api/users/${userId}/${kind}${query}`, { headers }), {
    params: Promise.resolve({ userId }),
  });
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = secret;
  getUserImageAccess.mockReset().mockResolvedValue({
    hasImage: true,
    profileVisibility: 'server_members',
    sharesServer: true,
  });
  getUserImageData.mockReset().mockResolvedValue({ value: PNG_DATA_URL, ref: VERSION });
});

describe('GET /api/users/{userId}/avatar', () => {
  it('requires a signed-in session', async () => {
    const response = await get('avatar', { viewer: null });
    expect(response.status).toBe(401);
    expect(getUserImageAccess).not.toHaveBeenCalled();
  });

  it('serves the decoded bytes with safe headers and immutable caching for the current version', async () => {
    const response = await get('avatar');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(PNG.length));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    expect(getUserImageAccess).toHaveBeenCalledWith({ __testDb: true }, { userId: OWNER, viewerUserId: VIEWER, kind: 'avatar' });
    expect(getUserImageData).toHaveBeenCalledWith({ __testDb: true }, OWNER, 'avatar');
  });

  it('caches briefly when the version is missing or stale', async () => {
    const stale = await get('avatar', { query: '?v=ffffffffffff' });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe('private, max-age=300');
    const unversioned = await get('avatar', { query: '' });
    expect(unversioned.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('404s when the user has no image', async () => {
    getUserImageAccess.mockResolvedValue({ hasImage: false, profileVisibility: 'everyone', sharesServer: true });
    const response = await get('avatar');
    expect(response.status).toBe(404);
    expect(getUserImageData).not.toHaveBeenCalled();
  });

  it('404s when the user is deleted or unknown', async () => {
    getUserImageAccess.mockResolvedValue(null);
    expect((await get('avatar')).status).toBe(404);
    expect(getUserImageData).not.toHaveBeenCalled();
  });

  it('404s on a malformed user id without touching the database', async () => {
    expect((await get('avatar', { userId: 'not-a-uuid' })).status).toBe(404);
    expect(getUserImageAccess).not.toHaveBeenCalled();
  });

  it('AUTHZ-005: "nobody" hides the image from everyone but its owner — before reading it', async () => {
    getUserImageAccess.mockResolvedValue({ hasImage: true, profileVisibility: 'nobody', sharesServer: true });
    const denied = await get('avatar');
    expect(denied.status).toBe(404);
    expect(getUserImageData).not.toHaveBeenCalled();

    const own = await get('avatar', { viewer: OWNER });
    expect(own.status).toBe(200);
  });

  it('AUTHZ-005: "server members" requires a shared server; "everyone" does not', async () => {
    getUserImageAccess.mockResolvedValue({ hasImage: true, profileVisibility: 'server_members', sharesServer: false });
    expect((await get('avatar')).status).toBe(404);
    getUserImageAccess.mockResolvedValue({ hasImage: true, profileVisibility: 'everyone', sharesServer: false });
    expect((await get('avatar')).status).toBe(200);
  });

  it('never serves a stored value that is not a sniffed PNG/JPEG/GIF/WebP', async () => {
    getUserImageData.mockResolvedValue({ value: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', ref: VERSION });
    expect((await get('avatar')).status).toBe(404);
    // Claims JPEG, contains PNG — the polyglot rule from upload applies here too.
    getUserImageData.mockResolvedValue({ value: `data:image/jpeg;base64,${PNG.toString('base64')}`, ref: VERSION });
    expect((await get('avatar')).status).toBe(404);
    // Legacy external URLs are linked directly by the lists, not proxied.
    getUserImageData.mockResolvedValue({ value: 'https://cdn.example.com/a.png', ref: 'https://cdn.example.com/a.png' });
    expect((await get('avatar')).status).toBe(404);
  });

  it('500s without detail when the database fails', async () => {
    getUserImageAccess.mockRejectedValue(new Error('connection refused'));
    const response = await get('avatar');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('connection refused');
  });
});

describe('GET /api/users/{userId}/banner', () => {
  it('serves the banner through the same rules', async () => {
    const response = await get('banner');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(getUserImageAccess).toHaveBeenCalledWith({ __testDb: true }, { userId: OWNER, viewerUserId: VIEWER, kind: 'banner' });
    expect(getUserImageData).toHaveBeenCalledWith({ __testDb: true }, OWNER, 'banner');
  });

  it('applies profile visibility to banners too', async () => {
    getUserImageAccess.mockResolvedValue({ hasImage: true, profileVisibility: 'nobody', sharesServer: true });
    expect((await get('banner')).status).toBe(404);
  });
});
