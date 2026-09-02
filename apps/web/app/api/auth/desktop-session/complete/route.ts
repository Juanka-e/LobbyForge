import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserById } from '@lobbyforge/db';
import { redis } from '@/lib/redis';
import { getDb } from '@/lib/db';
import { getSessionSecret } from '@/lib/api-auth';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Step 4 of the desktop session handoff (see ../route.ts): burn the
 * one-time code and issue the real session cookie. The desktop shell's
 * page calls this with the code the deep link delivered.
 */
const CompleteSchema = z.object({
  code: z.string().min(43).max(128),
});

interface HandoffRecord {
  userId: string;
  state: string;
  used: boolean;
}

async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = CompleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid handoff code.' }, { status: 400 });
  }

  const key = `lf:desktop-handoff:${parsed.data.code}`;
  const raw = await redis.get(key);
  if (!raw) {
    return NextResponse.json({ error: 'Handoff code expired or invalid.' }, { status: 401 });
  }
  let record: HandoffRecord;
  try {
    record = JSON.parse(raw) as HandoffRecord;
  } catch {
    return NextResponse.json({ error: 'Handoff code expired or invalid.' }, { status: 401 });
  }
  if (record.used) {
    // Replay attempt on an already-burned code.
    await redis.del(key);
    return NextResponse.json({ error: 'Handoff code already used.' }, { status: 401 });
  }

  const user = await getUserById(getDb(), record.userId);
  if (!user || user.deletedAt) {
    await redis.del(key);
    return NextResponse.json({ error: 'Account no longer available.' }, { status: 401 });
  }

  // Burn the code (single use).
  await redis.del(key);

  const sessionSeed = createGuestIdentity();
  const session = buildGuestSessionCookie(
    { gid: sessionSeed.gid, uid: user.id, name: user.displayName },
    getSessionSecret(),
    { secure: process.env.NODE_ENV === 'production' }
  );
  return NextResponse.json(
    { user: { id: user.id, displayName: user.displayName } },
    { headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'desktop-handoff-complete', config: { windowMs: 15 * 60_000, maxRequests: 15 } },
});
