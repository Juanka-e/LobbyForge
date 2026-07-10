import { describe, expect, it, vi } from 'vitest';
import { isMaintenanceExemptPath, readMaintenanceSnapshot } from '@/lib/maintenance-guard';

vi.mock('@lobbyforge/db', () => ({
  getEffectiveInstanceMaintenance: vi.fn(async () => {
    throw new Error('db unavailable');
  }),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({ __mockDb: true })),
}));

describe('maintenance guard', () => {
  it('exempts admin and health endpoints', () => {
    expect(isMaintenanceExemptPath('/api/admin/updates')).toBe(true);
    expect(isMaintenanceExemptPath('/api/admin/maintenance')).toBe(true);
    expect(isMaintenanceExemptPath('/api/health')).toBe(true);
    expect(isMaintenanceExemptPath('/api/doctor')).toBe(true);
    expect(isMaintenanceExemptPath('/api/test/db-reset')).toBe(true);
  });

  it('does not exempt normal app endpoints', () => {
    expect(isMaintenanceExemptPath('/api/servers')).toBe(false);
    expect(isMaintenanceExemptPath('/api/livekit/token')).toBe(false);
    expect(isMaintenanceExemptPath('/api/auth/guest')).toBe(false);
  });

  it('fails open when maintenance state cannot be read', async () => {
    await expect(readMaintenanceSnapshot()).resolves.toBeNull();
  });
});
