import { describe, expect, it } from 'vitest';
import type { BackupVerification } from '@/lib/backup-verifier';
import { executePreparedUpdateCommand, prepareUpdateCommand } from '@/lib/update-command-executor';
import { buildUpdatePlan, type UpdatePlan } from '@/lib/update-planner';
import { buildUpdateExecutionPreview, buildUpdateWorkerResult, isAllowedUpdateCommand } from '@/lib/update-runner';

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

describe('update runner preview', () => {
  it('keeps execution disabled by default', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: false,
    });

    expect(run.executable).toBe(false);
    expect(run.gates.executionEnabled).toBe(false);
    expect(run.failures).toContain('Update execution is disabled by LOBBYFORGE_UPDATE_EXECUTION_ENABLED.');
  });

  it('requires a verified release manifest signature', () => {
    const run = buildUpdateExecutionPreview(buildUpdatePlan({ version: '0.1.1' }, '0.1.0'), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
    });

    expect(run.gates.signedManifest).toBe(false);
    expect(run.failures).toContain('Release manifest signature is not verified.');
  });

  it('requires a verified backup', () => {
    const run = buildUpdateExecutionPreview(
      signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')),
      { ...backup, ok: false },
      {
        action: 'apply',
        adminConfirmed: true,
        executionEnabled: true,
      }
    );

    expect(run.gates.backupVerified).toBe(false);
    expect(run.failures).toContain('Backup verification did not pass.');
  });

  it('requires extra confirmation for major upgrades', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '2.0.0' }, '1.9.9')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
    });

    expect(run.gates.majorConfirmed).toBe(false);
    expect(run.failures).toContain('Major version upgrade requires extra confirmation.');
  });

  it('requires maintenance mode for apply previews', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      majorConfirmed: true,
      executionEnabled: true,
      maintenanceMode: false,
    });

    expect(run.gates.maintenanceMode).toBe(false);
    expect(run.failures).toContain('Maintenance mode must be enabled before apply or rollback.');
  });

  it('plans dry-run worker steps without command execution', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'dry-run',
    });
    const worker = buildUpdateWorkerResult(run);

    expect(run.gates.executionEnabled).toBe(true);
    expect(run.gates.commandExecutor).toBe(true);
    expect(worker.status).toBe('planned');
    expect(worker.steps.every((step) => step.status === 'planned')).toBe(true);
  });

  it('locks apply worker steps until the command executor exists', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
      maintenanceMode: true,
    });
    const worker = buildUpdateWorkerResult(run);

    expect(run.gates.commandExecutor).toBe(false);
    expect(worker.status).toBe('locked');
    expect(worker.failures).toContain('Update command executor is not implemented yet.');
  });

  it('can plan apply workers only when the worker executor gate is explicitly enabled', () => {
    const run = buildUpdateExecutionPreview(signed(buildUpdatePlan({ version: '0.1.1' }, '0.1.0')), backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
      workerExecutionEnabled: true,
      maintenanceMode: true,
    });
    const worker = buildUpdateWorkerResult(run);

    expect(run.failures).toEqual([]);
    expect(run.gates.commandExecutor).toBe(true);
    expect(worker.status).toBe('planned');
  });

  it('allows every default update plan command', () => {
    const plan = buildUpdatePlan({ version: '0.1.1' }, '0.1.0');

    expect(plan.steps.every((step) => isAllowedUpdateCommand(step.id, step.command))).toBe(true);
    expect(isAllowedUpdateCommand('rollback', plan.rollbackCommand)).toBe(true);
  });

  it('prepares allowlisted commands as argv descriptors without shell execution', () => {
    const prepared = prepareUpdateCommand('pull-images', 'docker compose pull');

    expect(prepared.ok).toBe(true);
    expect(prepared.descriptor).toMatchObject({
      executable: 'docker',
      args: ['compose', 'pull'],
      shell: false,
      cwd: 'workspace',
    });
  });

  it('keeps the prepared executor blocked by default', async () => {
    const prepared = prepareUpdateCommand('pull-images', 'docker compose pull');
    expect(prepared.descriptor).toBeDefined();

    const result = await executePreparedUpdateCommand(prepared.descriptor!, 'disabled');

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'Command executor is disabled.',
    });
  });

  it('rejects arbitrary manifest commands', () => {
    const plan = signed({
      ...buildUpdatePlan({ version: '0.1.1' }, '0.1.0'),
      steps: [
        {
          id: 'pull-images',
          title: 'Pull new Docker images',
          required: true,
          command: 'rm -rf /',
        },
      ],
    });
    const run = buildUpdateExecutionPreview(plan, backup, {
      action: 'apply',
      adminConfirmed: true,
      executionEnabled: true,
    });

    expect(run.gates.commandsAllowed).toBe(false);
    expect(run.steps[0]).toMatchObject({ allowed: false });
    expect(run.failures).toContain('One or more commands are outside the runner allowlist.');
  });
});
