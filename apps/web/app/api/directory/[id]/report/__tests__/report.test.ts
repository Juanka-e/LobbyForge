/**
 * POST /api/directory/{id}/report — a report must name an entry the
 * directory knows. The final test pass found reports accepted (201) and
 * stored for ids that were never in the directory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const getRegistryInstanceByInstanceId = vi.fn();
const instanceReports = { __table: 'instance_reports' };
const insertValues = vi.fn();
const dbInsert = vi.fn(() => ({ values: insertValues }));
const db = { __mockDb: true, insert: dbInsert };

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => ({ getRegistryInstanceByInstanceId, instanceReports }));
vi.mock('@/lib/db', () => ({ getDb: () => db }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
// security-review FILE-002: the directory write routes exist on the official hub only.
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => true }));

const UID = '00000000-0000-0000-0000-000000000099';
const INSTANCE_ID = '5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11';

beforeEach(() => {
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Reporter', exp: 123 },
  });
  getRegistryInstanceByInstanceId.mockReset();
  insertValues.mockReset().mockResolvedValue(undefined);
  dbInsert.mockClear();
});

async function report(id: string, body: unknown = { reason: 'spam', detail: 'ads everywhere' }): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request(`https://example.test/api/directory/${id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe('POST /api/directory/{id}/report', () => {
  it('files a report about an entry the directory knows', async () => {
    getRegistryInstanceByInstanceId.mockResolvedValue({ id: 'row-1', instanceId: INSTANCE_ID });
    const res = await report(INSTANCE_ID);
    expect(res.status).toBe(201);
    expect(getRegistryInstanceByInstanceId).toHaveBeenCalledWith(db, INSTANCE_ID);
    expect(dbInsert).toHaveBeenCalledWith(instanceReports);
    expect(insertValues).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID,
      reporterUserId: UID,
      reason: 'spam',
      detail: 'ads everywhere',
      status: 'pending',
    });
  });

  it('answers 404 for an id that is not in the directory, and stores nothing', async () => {
    getRegistryInstanceByInstanceId.mockResolvedValue(null);
    const res = await report('not-a-directory-entry');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Directory entry not found' });
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('still refuses an invalid body before any lookup', async () => {
    const res = await report(INSTANCE_ID, { reason: 'boring' });
    expect(res.status).toBe(400);
    expect(getRegistryInstanceByInstanceId).not.toHaveBeenCalled();
  });

  it('still requires a session', async () => {
    requireMaterializedSession.mockReturnValue({
      ok: false,
      response: NextResponse.json({ error: 'Auth required' }, { status: 401 }),
    });
    const res = await report(INSTANCE_ID);
    expect(res.status).toBe(401);
    expect(getRegistryInstanceByInstanceId).not.toHaveBeenCalled();
  });
});
