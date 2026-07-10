import { describe, expect, it } from 'vitest';
import type { BackupVerification } from '@/lib/backup-verifier';
import { buildUpdateExecutionPolicy } from '@/lib/update-execution-policy';
import { buildUpdatePlan, type UpdatePlan } from '@/lib/update-planner';
import { buildUpdateExecutionPreview, buildUpdateWorkerResult } from '@/lib/update-runner';

const backup: BackupVerification = {
  ok: true,
  backupId: 'backup-1',
  createdAt: '2026-06-11T10:00:00.000Z',
  ageMs: 1000,
  checks: [],
};

function signed(plan: UpdatePlan): UpdatePlan {
  return {
    ...plan,
    signature: { status: 'valid', verified: true, required: true, keyId: 'test-key' },
  };
}

describe('update execution policy', () => {
  it('keeps dry-run in dry-run mode', () => {
    const preview = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'dry-run',
    });
    const policy = buildUpdateExecutionPolicy({
      preview,
      worker: buildUpdateWorkerResult(preview),
    });

    expect(policy).toMatchObject({
      allowed: true,
      mode: 'dry-run',
      failures: [],
    });
  });

  it('keeps apply disabled unless execution is explicitly requested', () => {
    const preview = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
      workerExecutionEnabled: true,
      maintenanceMode: true,
    });
    const policy = buildUpdateExecutionPolicy({
      preview,
      worker: buildUpdateWorkerResult(preview),
    });

    expect(preview.failures).toEqual([]);
    expect(policy.mode).toBe('disabled');
    expect(policy.failures).toContain('Execution request was not explicitly enabled for this call.');
  });

  it('allows execute only after every preview gate and explicit request pass', () => {
    const preview = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
      workerExecutionEnabled: true,
      maintenanceMode: true,
    });
    const policy = buildUpdateExecutionPolicy({
      preview,
      worker: buildUpdateWorkerResult(preview),
      requestedExecution: true,
    });

    expect(policy).toEqual({
      allowed: true,
      mode: 'execute',
      failures: [],
    });
  });

  it('does not allow execute when preview gates fail', () => {
    const preview = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
      workerExecutionEnabled: true,
      maintenanceMode: false,
    });
    const policy = buildUpdateExecutionPolicy({
      preview,
      worker: buildUpdateWorkerResult(preview),
      requestedExecution: true,
    });

    expect(policy.allowed).toBe(false);
    expect(policy.mode).toBe('disabled');
    expect(policy.failures).toContain('Maintenance mode must be enabled before apply or rollback.');
  });
});
