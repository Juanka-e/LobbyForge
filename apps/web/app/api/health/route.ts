import { NextResponse } from 'next/server';
import { buildHealthStatus } from '@lobbyforge/core';
import { withApiSecurity } from '@/lib/security-headers';

const startedAt = new Date();

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(): Promise<NextResponse> {
  const status = buildHealthStatus({ web: true, started: true }, startedAt);
  return NextResponse.json(status, {
    status: status.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const GET = withApiSecurity(handler, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'health', config: { windowMs: 60_000, maxRequests: 120 } },
});
