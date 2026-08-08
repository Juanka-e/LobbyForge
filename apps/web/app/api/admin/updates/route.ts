import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createSystemUpdateEvent,
  createSystemUpdateRun,
  finishSystemUpdateRun,
  getEffectiveInstanceMaintenance,
  getSystemUpdateRunById,
  listSystemUpdateEvents,
  listSystemUpdateRuns,
  markSystemUpdateRunRunning,
  type SystemUpdateRunRow,
} from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { loadBackupManifest, verifyBackupManifest } from '@/lib/backup-verifier';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { buildUpdateExecutionPolicy } from '@/lib/update-execution-policy';
import { buildUpdateCheck, buildUpdatePlan, loadReleaseManifest } from '@/lib/update-planner';
import {
  buildUpdateExecutionPreview,
  buildUpdateWorkerResult,
  type UpdateExecutionAction,
  type UpdateWorkerResult,
} from '@/lib/update-runner';
import { executeUpdateWorkerWithEvents, recordUpdatePreviewEvents } from '@/lib/update-worker-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const UpdateRequestSchema = z.preprocess(
  (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !('action' in value)) {
      return { ...value, action: 'dry-run' };
    }
    return value;
  },
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('verify-backup'),
      requireFileExists: z.boolean().optional(),
    }).strict(),
    z.object({
      action: z.enum(['dry-run', 'apply', 'rollback']),
      requireFileExists: z.boolean().optional(),
      adminConfirmed: z.boolean().optional(),
      majorConfirmed: z.boolean().optional(),
      execute: z.boolean().optional(),
      maxOutputBytes: z.number().int().min(1024).max(1024 * 1024).optional(),
    }).strict(),
  ])
);

type HistoryWrite =
  | { updateRun: SystemUpdateRunRow; historyError?: string }
  | { updateRun?: undefined; historyError: string };

async function recordUpdatePreview(
  action: UpdateExecutionAction,
  plan: ReturnType<typeof buildUpdatePlan>,
  backupId: string | undefined,
  run: ReturnType<typeof buildUpdateExecutionPreview>,
  worker: UpdateWorkerResult,
  statusOverride?: SystemUpdateRunRow['status']
): Promise<HistoryWrite> {
  try {
    const updateRun = await createSystemUpdateRun(getDb(), {
      action,
      status: statusOverride ?? (action === 'dry-run' ? 'planned' : 'locked'),
      fromVersion: plan.currentVersion,
      toVersion: plan.latestVersion,
      channel: String(plan.channel),
      manifestKeyId: 'keyId' in plan.signature ? plan.signature.keyId ?? null : null,
      backupId: backupId ?? null,
      plan: {
        updateAvailable: plan.updateAvailable,
        majorUpgrade: plan.majorUpgrade,
        requiresAdminConfirmation: plan.requiresAdminConfirmation,
        requiresExtraMajorConfirmation: plan.requiresExtraMajorConfirmation,
        rollbackCommand: plan.rollbackCommand,
        steps: plan.steps,
      },
      gates: run.gates,
      failures: run.failures,
    });
    try {
      await recordUpdatePreviewEvents(
        async (event) => {
          await createSystemUpdateEvent(getDb(), {
            runId: updateRun.id,
            stepId: event.stepId,
            level: event.level,
            message: event.message,
            metadata: event.metadata,
          });
        },
        {
          action,
          status: updateRun.status,
          failureCount: run.failures.length,
          stepCount: run.steps.length,
          worker,
        }
      );
    } catch (err) {
      console.error('[admin/updates] event write failed:', (err as Error).message);
      return { updateRun, historyError: 'event write failed' };
    }

    return { updateRun };
  } catch (err) {
    console.error('[admin/updates] history write failed:', (err as Error).message);
    return { historyError: 'history write failed' };
  }
}

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'plan';
  const currentVersion = url.searchParams.get('currentVersion') ?? undefined;
  const channel = url.searchParams.get('channel') ?? undefined;

  if (action === 'history') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    const runs = await listSystemUpdateRuns(getDb(), { limit: Number.isFinite(limit) ? limit : 20 });
    return NextResponse.json({ runs }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'run') {
    const id = url.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required for action=run.' }, { status: 400 });
    const run = await getSystemUpdateRunById(getDb(), id);
    if (!run) return NextResponse.json({ error: 'Update run not found.' }, { status: 404 });
    const events = await listSystemUpdateEvents(getDb(), id);
    return NextResponse.json({ run, events }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action !== 'check' && action !== 'plan') {
    return NextResponse.json(
      { error: 'Invalid action. Use action=check, action=plan, action=history, or action=run.' },
      { status: 400 }
    );
  }

  try {
    const manifest = await loadReleaseManifest();
    const payload =
      action === 'check'
        ? { check: buildUpdateCheck(manifest, currentVersion, channel) }
        : { plan: buildUpdatePlan(manifest, currentVersion, channel) };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Failed to load update manifest' },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  const parsed = UpdateRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update request.' }, { status: 400 });
  }
  const body = parsed.data;

  if (body.action === 'verify-backup') {
    const { manifest, baseDir } = await loadBackupManifest();
    const backup = await verifyBackupManifest(manifest, {
      baseDir,
      requireFileExists: body.requireFileExists === true,
    });
    return NextResponse.json({ backup }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const action: UpdateExecutionAction = body.action;

  const plan = buildUpdatePlan(await loadReleaseManifest());
  const { manifest, baseDir } = await loadBackupManifest();
  const backup = await verifyBackupManifest(manifest, {
    baseDir,
    requireFileExists: body.requireFileExists === true,
  });
  const maintenance = await getEffectiveInstanceMaintenance(getDb());
  const run = buildUpdateExecutionPreview(plan, backup, {
    action,
    adminConfirmed: body.adminConfirmed,
    majorConfirmed: body.majorConfirmed,
    maintenanceMode: maintenance.maintenanceMode,
  });
  const worker = buildUpdateWorkerResult(run);
  const policy = buildUpdateExecutionPolicy({
    preview: run,
    worker,
    requestedExecution: body.execute === true,
  });
  const history = await recordUpdatePreview(
    action,
    plan,
    backup.backupId,
    run,
    worker,
    policy.allowed && policy.mode === 'execute' ? 'running' : undefined
  );

  if (action === 'dry-run') {
    return NextResponse.json(
      { plan, backup, maintenance, run, worker, policy, ...history },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (policy.allowed && policy.mode === 'execute' && history.updateRun) {
    await markSystemUpdateRunRunning(getDb(), history.updateRun.id);
    const execution = await executeUpdateWorkerWithEvents(worker, {
      mode: policy.mode,
      maxOutputBytes: Number.isFinite(body.maxOutputBytes) ? body.maxOutputBytes : undefined,
      recordEvent: async (event) => {
        await createSystemUpdateEvent(getDb(), {
          runId: history.updateRun.id,
          stepId: event.stepId,
          level: event.level,
          message: event.message,
          metadata: event.metadata,
        });
      },
    });
    const finalStatus =
      execution.status === 'succeeded'
        ? action === 'rollback'
          ? 'rolled_back'
          : 'succeeded'
        : 'failed';
    const finished = await finishSystemUpdateRun(getDb(), history.updateRun.id, finalStatus, execution.failures);

    return NextResponse.json(
      {
        plan,
        backup,
        maintenance,
        run,
        worker,
        policy,
        execution,
        updateRun: finished ?? history.updateRun,
        historyError: history.historyError,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      error: 'Update execution is locked',
      detail:
        'Apply/rollback require a signed manifest, verified backup, explicit confirmation, and the self-host script runner.',
      plan,
      backup,
      maintenance,
      run,
      worker,
      policy,
      ...history,
    },
    { status: 501, headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-updates-get', config: { windowMs: 60_000, maxRequests: 20 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'admin-updates-post', config: { windowMs: 60_000, maxRequests: 5 } },
});
