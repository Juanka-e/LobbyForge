import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const getEffectiveInstanceAccessSettings = vi.fn();
const setInstanceAccessSettings = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requireAdminHealthToken,
}));

vi.mock('@lobbyforge/db', () => ({
  getEffectiveInstanceAccessSettings,
  setInstanceAccessSettings,
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

const sampleSettings = {
  instanceId: 'self-host',
  registrationMode: 'invite_only',
  guestAccessEnabled: true,
  seoIndexingEnabled: false,
  seoTitle: null,
  seoDescription: null,
  updatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  requireAdminHealthToken.mockReset();
  getEffectiveInstanceAccessSettings.mockReset();
  setInstanceAccessSettings.mockReset();
  // Default: admin allowed (null).
  requireAdminHealthToken.mockResolvedValue(null);
});

describe('GET /api/admin/instance-settings', () => {
  it('returns the effective settings when admin is allowed', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue(sampleSettings);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/instance-settings'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: typeof sampleSettings };
    expect(json.settings).toEqual(sampleSettings);
  });

  it('rejects with the denied response when requireAdminHealthToken returns one', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/instance-settings'), {});
    expect(res.status).toBe(401);
    expect(getEffectiveInstanceAccessSettings).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/instance-settings', () => {
  it('persists a valid settings body and returns it', async () => {
    const updated = { ...sampleSettings, registrationMode: 'closed' as const };
    setInstanceAccessSettings.mockResolvedValue(updated);
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/instance-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          registrationMode: 'closed',
          guestAccessEnabled: true,
          seoIndexingEnabled: false,
        }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: typeof updated };
    expect(json.settings.registrationMode).toBe('closed');
    expect(setInstanceAccessSettings).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ registrationMode: 'closed' })
    );
  });

  it('returns 400 for an invalid body (missing required field)', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/instance-settings', {
        method: 'PATCH',
        body: JSON.stringify({ registrationMode: 'open' }), // missing guestAccessEnabled + seoIndexingEnabled
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect(setInstanceAccessSettings).not.toHaveBeenCalled();
  });

  it('returns 400 for an extra (unknown) field due to .strict()', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/instance-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          registrationMode: 'open',
          guestAccessEnabled: true,
          seoIndexingEnabled: false,
          rogueField: 'no',
        }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('rejects with 401 when admin is denied', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request('https://example.test/api/admin/instance-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          registrationMode: 'open',
          guestAccessEnabled: true,
          seoIndexingEnabled: false,
        }),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });
});
