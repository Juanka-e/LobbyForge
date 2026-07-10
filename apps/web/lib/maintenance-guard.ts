import { NextResponse } from 'next/server';

const MAINTENANCE_EXEMPT_PREFIXES = [
  '/api/admin',
  '/api/health',
  '/api/doctor',
  '/api/test',
] as const;

export interface MaintenanceSnapshot {
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  maintenanceStartedAt: Date | null;
}

export function isMaintenanceExemptPath(pathname: string): boolean {
  return MAINTENANCE_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function readMaintenanceSnapshot(): Promise<MaintenanceSnapshot | null> {
  try {
    const [{ getEffectiveInstanceMaintenance }, { getDb }] = await Promise.all([
      import('@lobbyforge/db'),
      import('@/lib/db'),
    ]);
    const maintenance = await getEffectiveInstanceMaintenance(getDb());
    return {
      maintenanceMode: maintenance.maintenanceMode,
      maintenanceMessage: maintenance.maintenanceMessage,
      maintenanceStartedAt: maintenance.maintenanceStartedAt,
    };
  } catch {
    return null;
  }
}

export async function maintenanceResponseForRequest(req: Request): Promise<NextResponse | null> {
  const pathname = new URL(req.url).pathname;
  if (isMaintenanceExemptPath(pathname)) return null;

  const maintenance = await readMaintenanceSnapshot();
  if (!maintenance?.maintenanceMode) return null;

  return NextResponse.json(
    {
      error: 'Maintenance mode',
      message: maintenance.maintenanceMessage ?? 'LobbyForge is temporarily in maintenance mode.',
      startedAt: maintenance.maintenanceStartedAt?.toISOString() ?? null,
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '60',
      },
    }
  );
}
