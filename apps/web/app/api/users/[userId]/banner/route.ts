import { withApiSecurity } from '@/lib/security-headers';
import { handleUserImageGet } from '@/lib/user-image-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/users/{userId}/banner?v=<version> — the user's banner bytes.
 *
 * security-review FILE-001: banners are no longer part of any list; the
 * profile popover requests one when it opens. Readers and caching are
 * documented in lib/user-image-route.ts (signed-in session + the owner's
 * profile visibility, AUTHZ-005).
 */
async function handleGet(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  return handleUserImageGet(req, ctx, 'banner');
}

// One banner per opened profile popover — far fewer than avatars.
export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'user-banner-get', config: { windowMs: 60_000, maxRequests: 240 } },
});
