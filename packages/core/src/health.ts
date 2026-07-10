export interface HealthStatus {
  ok: boolean;
  checks: Record<string, boolean>;
  uptimeSeconds?: number;
}

export function buildHealthStatus(
  checks: Record<string, boolean>,
  startedAt?: Date
): HealthStatus {
  const ok = Object.values(checks).every((val) => val === true);
  const uptimeSeconds = startedAt
    ? Math.floor((Date.now() - startedAt.getTime()) / 1000)
    : undefined;
  return {
    ok,
    checks,
    ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
  };
}
