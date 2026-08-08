import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const getEffectiveInstanceMaintenance = vi.fn();
const setInstanceMaintenance = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requireAdminHealthToken,
}));

vi.mock('@lobbyforge/db', () => ({
  getEffectiveInstanceMaintenance,
  setInstanceMaintenance,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDb: true }),
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

async function loadRoute() {
  return import('../route.js');
}

const sampleMaintenance = {
  instanceId: 'self-host',
  maintenanceMode: false,
  maintenanceMessage: null,
  maintenanceStartedAt: null,
  maintenanceUpdatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  requireAdminHealthToken.mockReset();
  getEffectiveInstanceMaintenance.mockReset();
  setInstanceMaintenance.mockReset();
  requireAdminHealthToken.mockResolvedValue(null);
});

describe('GET /api/admin/maintenance', () => {
  it('returns the maintenance status when admin is allowed', async () => {
    getEffectiveInstanceMaintenance.mockResolvedValue(sampleMaintenance);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/maintenance'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { maintenance: typeof sampleMaintenance };
    expect(json.maintenance.maintenanceMode).toBe(false);
  });

  it('rejects with the denied response when admin is not allowed', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/maintenance'), {});
    expect(res.status).toBe(401);
    expect(getEffectiveInstanceMaintenance).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/maintenance', () => {
  it('enables maintenance mode with a message and returns the updated status', async () => {
    const updated = {
      ...sampleMaintenance,
      maintenanceMode: true,
      maintenanceMessage: 'Deploying',
    };
    setInstanceMaintenance.mockResolvedValue(updated);
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/maintenance', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true, message: 'Deploying' }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { maintenance: typeof updated };
    expect(json.maintenance.maintenanceMode).toBe(true);
    expect(setInstanceMaintenance).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ enabled: true, message: 'Deploying' })
    );
  });

  it('normalizes a missing message to null', async () => {
    setInstanceMaintenance.mockResolvedValue({ ...sampleMaintenance, maintenanceMode: true });
    const { PATCH } = await loadRoute();
    await PATCH(
      new Request('https://example.test/api/admin/maintenance', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      }),
      {}
    );
    expect(setInstanceMaintenance).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ message: null })
    );
  });

  it('returns 400 when the body is invalid (missing enabled)', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/maintenance', {
        method: 'PATCH',
        body: JSON.stringify({ message: 'oops' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect(setInstanceMaintenance).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown field due to .strict()', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/maintenance', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true, rogue: 1 }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });
});
