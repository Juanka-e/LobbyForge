import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
  updateServerBannerUrl,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { BANNER_LIMITS, checkImageDataUrl } from '@/lib/image-validation';
import { checkUserImageQuota, quotaExceededResponse } from '@/lib/upload-quota';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BannerPayloadSchema = z.object({
  // Structural check here; content-sniffed format (GIF included) and
  // dimension enforcement (min 960×540, max 4096) live in
  // checkImageDataUrl — same contract as the user banner.
  dataUrl: z
    .string()
    .min(64, 'Banner data is too small.')
    .max(BANNER_LIMITS.maxDataUrlBytes, 'Banner data is too large (max 8 MB).')
    .nullable(),
});

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const session = readGuestSession(req.headers.get('cookie'), getSessionSecret());
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

/** Membership + MANAGE_SERVER gate (banner is a server-level setting).
 * Returns a NextResponse when denied, else the server row. */
async function requireBannerManager(
  serverId: string,
  actorUserId: string
): Promise<NextResponse | { server: { ownerUserId: string } }> {
  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }
  if (server.ownerUserId !== actorUserId) {
    if (!(await isServerMember(getDb(), actorUserId, serverId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  const permissions = await getUserPermissions(getDb(), actorUserId, serverId);
  if (!hasPermission(permissions, CorePermission.MANAGE_SERVER)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { server };
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const gate = await requireBannerManager(serverId, session.uid);
    if (gate instanceof NextResponse) return gate;

    let body: z.infer<typeof BannerPayloadSchema>;
    try {
      body = BannerPayloadSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'Invalid banner payload' }, { status: 400 });
    }

    if (body.dataUrl !== null) {
      // GIF87a/GIF89a accepted (animated server banners, Discord-style).
      const check = checkImageDataUrl(body.dataUrl, BANNER_LIMITS);
      if (!check.ok) {
        return NextResponse.json({ error: check.error ?? 'Invalid banner image.' }, { status: 400 });
      }
      // SEC-010: server banners count against the OWNER's image quota
      // (they own the stored bytes); null = removal, frees budget.
      const quota = await checkUserImageQuota(gate.server.ownerUserId, body.dataUrl.length);
      if (!quota.ok) return quotaExceededResponse(quota);
    }

    const updated = await updateServerBannerUrl(getDb(), serverId, body.dataUrl);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'server.banner.update',
      targetType: 'server',
      targetId: serverId,
      metadata: { cleared: body.dataUrl === null },
    }).catch((err) => console.error('[audit] server.banner.update failed:', (err as Error).message));
    return NextResponse.json(
      { bannerUrl: updated.bannerUrl },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[server/banner] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to update server banner' }, { status: 500 });
  }
}

/**
 * DELETE clears the banner (equivalent to POST with dataUrl: null —
 * kept as a convenience for the settings UI).
 */
async function handleDelete(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const gate = await requireBannerManager(serverId, session.uid);
    if (gate instanceof NextResponse) return gate;

    const updated = await updateServerBannerUrl(getDb(), serverId, null);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'server.banner.clear',
      targetType: 'server',
      targetId: serverId,
      metadata: {},
    }).catch((err) => console.error('[audit] server.banner.clear failed:', (err as Error).message));
    return NextResponse.json({ bannerUrl: updated.bannerUrl });
  } catch (err) {
    console.error('[server/banner] clear failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to clear server banner' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: BANNER_LIMITS.maxDataUrlBytes + 1024,
  rateLimit: { identifier: 'server-banner-post', config: { windowMs: 60_000, maxRequests: 8 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-banner-delete', config: { windowMs: 60_000, maxRequests: 10 } },
});
