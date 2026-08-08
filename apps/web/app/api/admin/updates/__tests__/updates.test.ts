import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const listSystemUpdateRuns = vi.fn();
const getSystemUpdateRunById = vi.fn();
const listSystemUpdateEvents = vi.fn();
const createSystemUpdateRun = vi.fn();
const createSystemUpdateEvent = vi.fn();
const markSystemUpdateRunRunning = vi.fn();
const finishSystemUpdateRun = vi.fn();
const getEffectiveInstanceMaintenance = vi.fn();
const loadReleaseManifest = vi.fn();
const buildUpdateCheck = vi.fn();
const buildUpdatePlan = vi.fn();
const loadBackupManifest = vi.fn();
const verifyBackupManifest = vi.fn();
const buildUpdateExecutionPreview = vi.fn();
const buildUpdateWorkerResult = vi.fn();
const buildUpdateExecutionPolicy = vi.fn();
const recordUpdatePreviewEvents = vi.fn();

vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken }));
vi.mock('@lobbyforge/db', () => ({
  listSystemUpdateRuns,
  getSystemUpdateRunById,
  listSystemUpdateEvents,
  createSystemUpdateRun,
  createSystemUpdateEvent,
  markSystemUpdateRunRunning,
  finishSystemUpdateRun,
  getEffectiveInstanceMaintenance,
}));
vi.mock('@/lib/update-planner', () => ({
  loadReleaseManifest,
  buildUpdateCheck,
  buildUpdatePlan,
}));
vi.mock('@/lib/backup-verifier', () => ({ loadBackupManifest, verifyBackupManifest }));
vi.mock('@/lib/update-runner', () => ({
  buildUpdateExecutionPreview,
  buildUpdateWorkerResult,
}));
vi.mock('@/lib/update-execution-policy', () => ({ buildUpdateExecutionPolicy }));
vi.mock('@/lib/update-worker-events', () => ({
  executeUpdateWorkerWithEvents: vi.fn(),
  recordUpdatePreviewEvents,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

async function loadRoute() {
  return import('../route.js');
}

const samplePlan = {
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  updateAvailable: true,
  majorUpgrade: false,
  requiresAdminConfirmation: false,
  requiresExtraMajorConfirmation: false,
  rollbackCommand: 'rollback.sh',
  channel: 'stable',
  signature: { keyId: 'key-1' },
  steps: [],
};

beforeEach(() => {
  vi.resetModules();
  requireAdminHealthToken.mockReset();
  listSystemUpdateRuns.mockReset();
  getSystemUpdateRunById.mockReset();
  listSystemUpdateEvents.mockReset();
  createSystemUpdateRun.mockReset();
  createSystemUpdateEvent.mockReset();
  markSystemUpdateRunRunning.mockReset();
  finishSystemUpdateRun.mockReset();
  getEffectiveInstanceMaintenance.mockReset();
  loadReleaseManifest.mockReset();
  buildUpdateCheck.mockReset();
  buildUpdatePlan.mockReset();
  loadBackupManifest.mockReset();
  verifyBackupManifest.mockReset();
  buildUpdateExecutionPreview.mockReset();
  buildUpdateWorkerResult.mockReset();
  buildUpdateExecutionPolicy.mockReset();
  recordUpdatePreviewEvents.mockReset();
  // Default: admin allowed.
  requireAdminHealthToken.mockResolvedValue(null);
});

describe('GET /api/admin/updates admin gating', () => {
  it('rejects with the denied response when requireAdminHealthToken returns one', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates'), {});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/updates action=history', () => {
  it('returns the list of past runs', async () => {
    listSystemUpdateRuns.mockResolvedValue([{ id: 'run-1', status: 'succeeded' }]);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=history'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { runs: unknown[] };
    expect(json.runs).toHaveLength(1);
  });
});

describe('GET /api/admin/updates action=run', () => {
  it('returns 400 when id is missing', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=run'), {});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the run does not exist', async () => {
    getSystemUpdateRunById.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=run&id=run-1'), {});
    expect(res.status).toBe(404);
  });

  it('returns the run and its events', async () => {
    getSystemUpdateRunById.mockResolvedValue({ id: 'run-1', status: 'succeeded' });
    listSystemUpdateEvents.mockResolvedValue([{ stepId: 's1', level: 'info' }]);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=run&id=run-1'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run: { id: string }; events: unknown[] };
    expect(json.run.id).toBe('run-1');
    expect(json.events).toHaveLength(1);
  });
});

describe('GET /api/admin/updates action=check', () => {
  it('returns the update check payload', async () => {
    loadReleaseManifest.mockResolvedValue({ version: '0.2.0' });
    buildUpdateCheck.mockReturnValue({ updateAvailable: true });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=check'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { check: { updateAvailable: boolean } };
    expect(json.check.updateAvailable).toBe(true);
  });

  it('returns 500 when the manifest fails to load', async () => {
    loadReleaseManifest.mockRejectedValue(new Error('fetch failed'));
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=check'), {});
    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/updates action=invalid', () => {
  it('returns 400 for an unknown action', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/updates?action=bogus'), {});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/updates dry-run', () => {
  it('returns the plan, backup, and preview without executing', async () => {
    buildUpdatePlan.mockReturnValue(samplePlan);
    loadBackupManifest.mockResolvedValue({ manifest: {}, baseDir: '/tmp' });
    verifyBackupManifest.mockResolvedValue({ ok: true, backupId: 'bk-1', failures: [] });
    getEffectiveInstanceMaintenance.mockResolvedValue({ maintenanceMode: false });
    buildUpdateExecutionPreview.mockReturnValue({ gates: [], failures: [], steps: [] });
    buildUpdateWorkerResult.mockReturnValue({ steps: [], failures: [], status: 'pending' });
    buildUpdateExecutionPolicy.mockReturnValue({ allowed: false, mode: 'preview' });
    createSystemUpdateRun.mockResolvedValue({ id: 'run-2', status: 'planned' });

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/updates', {
        method: 'POST',
        body: JSON.stringify({ action: 'dry-run' }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plan: { latestVersion: string }; run: unknown };
    expect(json.plan.latestVersion).toBe('0.2.0');
    // A dry-run records a planned run in history.
    expect(createSystemUpdateRun).toHaveBeenCalled();
    // dry-run never executes.
    expect(markSystemUpdateRunRunning).not.toHaveBeenCalled();
  });

  it('rejects an invalid action value in the body', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/updates', {
        method: 'POST',
        body: JSON.stringify({ action: 'bogus' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('rejects when admin is denied', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/updates', {
        method: 'POST',
        body: JSON.stringify({ action: 'dry-run' }),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });
});
