import { NextResponse } from 'next/server';
import Redis from 'ioredis';
import { requireTestResetAccess } from '@/lib/test-reset-auth';

export async function POST(req: Request) {
  const denied = requireTestResetAccess(req);
  if (denied) return denied;

  const redisUrl = process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379';
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  redis.quit();
  return NextResponse.json({ ok: true });
}
