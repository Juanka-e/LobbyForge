import { withApiSecurity } from '@/lib/security-headers';
import { handleUserImageGet } from '@/lib/user-image-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/users/{userId}/avatar?v=<version> — the user's avatar bytes.
 *
 * security-review FILE-001: lists link here instead of inlining the data
 * URL. Readers and caching are documented in lib/user-image-route.ts
 * (signed-in session + the owner's profile visibility, AUTHZ-005).
 */
async function handleGet(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  return handleUserImageGet(req, ctx, 'avatar');
}

// A cold lobby loads every visible member's avatar at once (the member
// list is capped at 500); after that the browser cache serves them, so
// the limit only has to absorb first loads — several people behind one
// NAT included.
export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'user-avatar-get', config: { windowMs: 60_000, maxRequests: 1200 } },
});
