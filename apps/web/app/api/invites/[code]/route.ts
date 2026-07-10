import { NextResponse } from 'next/server';
import { getInviteMetadata } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { normalizeInviteCode } from '@/lib/invite-code';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Public invite metadata endpoint. No PII — the join page calls this
 * before the user has accepted so it can render "you're about to join
 * <ServerName>". No auth required: anyone with the code can see the
 * server's display name + the invite's expiry / use-count.
 */
async function handleGet(_req: Request, ctx: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const { code: rawCode } = await ctx.params;
  try {
    const code = normalizeInviteCode(rawCode ?? '');
    if (!code) {
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 400 });
    }
    const meta = await getInviteMetadata(getDb(), code);
    if (!meta) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    return NextResponse.json(
      {
        invite: {
          code: meta.code,
          serverId: meta.serverId,
          serverName: meta.serverName,
          expiresAt: meta.expiresAt ? meta.expiresAt.toISOString() : null,
          currentUses: meta.currentUses,
          maxUses: meta.maxUses,
          isExpired: meta.isExpired,
          isExhausted: meta.isExhausted,
        },
      },
      {
        // Don't cache — `currentUses` changes on every redeem.
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch invite' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'invite-metadata', config: { windowMs: 60_000, maxRequests: 60 } },
});
