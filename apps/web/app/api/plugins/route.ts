import { NextResponse } from 'next/server';
import { listPluginSummaries } from '@/lib/plugin-registry';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function handleGet(): NextResponse {
  return NextResponse.json(
    { plugins: listPluginSummaries() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'plugins-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
