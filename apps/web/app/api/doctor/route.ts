import { NextResponse } from 'next/server';
import type { SystemStats } from '@lobbyforge/core';
import { collectDoctorReport } from '@/lib/doctor';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { resolveClientAddress, withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;
  // INFRA-V-01: the caller's own address is one signal for `client_address`.
  const { report, stats } = await collectDoctorReport({ clientAddress: resolveClientAddress(req) });
  return NextResponse.json(
    { report, stats: redactStatsForPublic(stats) },
    {
      status: report.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

/**
 * /api/doctor is admin-facing. Strip fields that would be useful to an
 * attacker but not useful to an admin reviewing the report.
 */
function redactStatsForPublic(stats: SystemStats): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...stats };
  // Strip process-level timestamps and absolute hardware sizes.
  // Keep ratios (percentages) which are all the admin needs for capacity
  // decisions without exposing a host hardware fingerprint.
  delete safe.startedAt;
  delete (safe as Record<string, unknown>).totalMemoryBytes;
  delete (safe as Record<string, unknown>).freeMemoryBytes;
  delete (safe as Record<string, unknown>).totalDiskBytes;
  delete (safe as Record<string, unknown>).freeDiskBytes;
  // Compute memory free ratio (keep it for the capacity tier check).
  if (stats.totalMemoryBytes > 0) {
    safe.memoryFreeRatio = stats.freeMemoryBytes / stats.totalMemoryBytes;
  }
  return safe;
}

export const GET = withApiSecurity(handler, {
  allowedMethods: ['GET'],
  // Doctor is moderately expensive (parallel HTTP probes); rate-limit harder.
  rateLimit: { identifier: 'doctor', config: { windowMs: 60_000, maxRequests: 12 } },
});
