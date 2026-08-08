import { NextResponse } from 'next/server';
import Redis from 'ioredis';
import { requireTestResetAccess } from '@/lib/test-reset-auth';
import { withApiSecurity } from '@/lib/security-headers';

async function handlePost(req: Request): Promise<NextResponse> {
  const denied = requireTestResetAccess(req);
  if (denied) return denied;

  const redisUrl = process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379';
  const redis = new Redis(redisUrl);
  try {
    await redis.flushdb();
  } finally {
    await redis.quit().catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maintenanceMode: 'bypass',
  sessionRevocation: 'bypass',
  maxBodyBytes: 0,
  rateLimit: { identifier: 'test-redis-reset', config: { windowMs: 60_000, maxRequests: 5 } },
});
