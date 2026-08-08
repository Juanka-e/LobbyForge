import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireServerMember = vi.fn();
const requireServerPermission = vi.fn();
const getEffectiveServerAccessPolicy = vi.fn();
const upsertServerAccessPolicy = vi.fn();
const logAction = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  CorePermission: { MANAGE_SERVER: 'manage_server' },
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
}));
vi.mock('@lobbyforge/db', () => ({
  getEffectiveServerAccessPolicy,
  upsertServerAccessPolicy,
  logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const UID = '00000000-0000-0000-0000-000000000099';

const samplePolicy = {
  id: 'pol-1',
  serverId: SERVER_ID,
  joinPolicy: 'invite_only',
  externalIdentity: 'off',
  localAccount: 'allow_local_email_password',
  accountLinking: 'allow_link',
  requireApprovalForFirstJoin: false,
  updatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireServerMember.mockReset();
  requireServerPermission.mockReset();
  getEffectiveServerAccessPolicy.mockReset();
  upsertServerAccessPolicy.mockReset();
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireServerMember.mockResolvedValue({ ok: true });
  requireServerPermission.mockResolvedValue({ ok: true });
});

function ctx() {
  return { params: Promise.resolve({ id: SERVER_ID }) };
}

const validBody = {
  joinPolicy: 'invite_only',
  externalIdentity: 'off',
  localAccount: 'allow_local_email_password',
  accountLinking: 'allow_link',
  requireApprovalForFirstJoin: false,
};

describe('GET /api/servers/[id]/access-policy', () => {
  it('returns the access policy for a member', async () => {
    getEffectiveServerAccessPolicy.mockResolvedValue(samplePolicy);
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`), ctx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accessPolicy: { joinPolicy: string } };
    expect(json.accessPolicy.joinPolicy).toBe('invite_only');
  });

  it('returns the denied response when the caller is not a member', async () => {
    requireServerMember.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`), ctx());
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/servers/[id]/access-policy', () => {
  it('upserts the policy and returns it when MANAGE_SERVER is granted', async () => {
    const updated = { ...samplePolicy, joinPolicy: 'public_self_register' };
    upsertServerAccessPolicy.mockResolvedValue(updated);
    const { PATCH } = await import('../route.js');
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`, {
        method: 'PATCH',
        body: JSON.stringify({ ...validBody, joinPolicy: 'public_self_register' }),
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(upsertServerAccessPolicy).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ serverId: SERVER_ID, joinPolicy: 'public_self_register' })
    );
    expect(logAction).toHaveBeenCalled();
  });

  it('returns 403 when the caller lacks MANAGE_SERVER permission', async () => {
    requireServerPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { PATCH } = await import('../route.js');
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`, {
        method: 'PATCH',
        body: JSON.stringify(validBody),
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(upsertServerAccessPolicy).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid joinPolicy value', async () => {
    const { PATCH } = await import('../route.js');
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`, {
        method: 'PATCH',
        body: JSON.stringify({ ...validBody, joinPolicy: 'bogus' }),
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for an extra unknown field due to .strict()', async () => {
    const { PATCH } = await import('../route.js');
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/access-policy`, {
        method: 'PATCH',
        body: JSON.stringify({ ...validBody, rogue: true }),
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });
});
