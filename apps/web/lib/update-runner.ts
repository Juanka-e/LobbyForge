import type { BackupVerification } from '@/lib/backup-verifier';
import {
  getUpdateCommandExecutionMode,
  isUpdateCommandAllowlisted,
  prepareUpdateCommand,
  type UpdateCommandDescriptor,
} from '@/lib/update-command-executor';
import type { UpdatePlan } from '@/lib/update-planner';

export type UpdateExecutionAction = 'dry-run' | 'apply' | 'rollback';

export interface UpdateExecutionRequest {
  action: UpdateExecutionAction;
  adminConfirmed?: boolean;
  majorConfirmed?: boolean;
  executionEnabled?: boolean;
  workerExecutionEnabled?: boolean;
  maintenanceMode?: boolean;
}

export interface UpdateExecutionStepPreview {
  id: string;
  title: string;
  command: string;
  allowed: boolean;
  descriptor?: UpdateCommandDescriptor;
  reason?: string;
}

export interface UpdateExecutionPreview {
  action: UpdateExecutionAction;
  executable: false;
  gates: {
    executionEnabled: boolean;
    commandExecutor: boolean;
    signedManifest: boolean;
    backupVerified: boolean;
    adminConfirmed: boolean;
    majorConfirmed: boolean;
    maintenanceMode: boolean;
    commandsAllowed: boolean;
  };
  failures: string[];
  steps: UpdateExecutionStepPreview[];
}

export interface UpdateWorkerStepResult extends UpdateExecutionStepPreview {
  status: 'planned' | 'blocked';
  skippedReason?: string;
}

export interface UpdateWorkerResult {
  action: UpdateExecutionAction;
  status: 'planned' | 'locked';
  executable: false;
  failures: string[];
  steps: UpdateWorkerStepResult[];
}

function isExecutionEnabled(input?: boolean): boolean {
  return input ?? process.env.LOBBYFORGE_UPDATE_EXECUTION_ENABLED === 'true';
}

function isWorkerExecutionEnabled(input?: boolean): boolean {
  return input ?? process.env.LOBBYFORGE_UPDATE_WORKER_EXECUTION_ENABLED === 'true';
}

function isCommandExecutorAvailable(action: UpdateExecutionAction, input?: boolean): boolean {
  return getUpdateCommandExecutionMode(action) !== 'disabled' || isWorkerExecutionEnabled(input);
}

export function isAllowedUpdateCommand(stepId: string, command: string): boolean {
  return isUpdateCommandAllowlisted(stepId, command);
}

function previewStep(id: string, title: string, command: string): UpdateExecutionStepPreview {
  const prepared = prepareUpdateCommand(id, command);
  return {
    id,
    title,
    command,
    allowed: prepared.ok,
    descriptor: prepared.descriptor,
    reason: prepared.reason,
  };
}

export function buildUpdateExecutionPreview(
  plan: UpdatePlan,
  backup: BackupVerification,
  request: UpdateExecutionRequest
): UpdateExecutionPreview {
  const steps =
    request.action === 'rollback'
      ? [previewStep('rollback', 'Rollback services', plan.rollbackCommand)]
      : plan.steps.map((step) => previewStep(step.id, step.title, step.command));
  const gates = {
    executionEnabled: request.action === 'dry-run' || isExecutionEnabled(request.executionEnabled),
    commandExecutor: isCommandExecutorAvailable(request.action, request.workerExecutionEnabled),
    signedManifest: plan.signature.verified,
    backupVerified: backup.ok,
    adminConfirmed: request.action === 'dry-run' || request.adminConfirmed === true,
    majorConfirmed: request.action === 'dry-run' || !plan.majorUpgrade || request.majorConfirmed === true,
    maintenanceMode: request.action === 'dry-run' || request.maintenanceMode === true,
    commandsAllowed: steps.every((step) => step.allowed),
  };
  const failures = [
    gates.executionEnabled ? undefined : 'Update execution is disabled by LOBBYFORGE_UPDATE_EXECUTION_ENABLED.',
    gates.commandExecutor ? undefined : 'Update command executor is not implemented yet.',
    gates.signedManifest ? undefined : 'Release manifest signature is not verified.',
    gates.backupVerified ? undefined : 'Backup verification did not pass.',
    gates.adminConfirmed ? undefined : 'Admin confirmation is required.',
    gates.majorConfirmed ? undefined : 'Major version upgrade requires extra confirmation.',
    gates.maintenanceMode ? undefined : 'Maintenance mode must be enabled before apply or rollback.',
    gates.commandsAllowed ? undefined : 'One or more commands are outside the runner allowlist.',
  ].filter((item): item is string => Boolean(item));

  return {
    action: request.action,
    executable: false,
    gates,
    failures,
    steps,
  };
}

export function buildUpdateWorkerResult(preview: UpdateExecutionPreview): UpdateWorkerResult {
  const locked = preview.failures.length > 0;
  return {
    action: preview.action,
    status: locked ? 'locked' : 'planned',
    executable: false,
    failures: preview.failures,
    steps: preview.steps.map((step) => ({
      ...step,
      status: locked || !step.allowed ? 'blocked' : 'planned',
      skippedReason: locked ? preview.failures[0] : step.reason,
    })),
  };
}
