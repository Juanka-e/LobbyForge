import {
  executePreparedUpdateCommand,
  type ExecutePreparedUpdateCommandOptions,
  type UpdateCommandExecutionEvent,
  type UpdateCommandExecutionMode,
  type UpdateCommandExecutionResult,
} from '@/lib/update-command-executor';
import type { UpdateWorkerResult, UpdateWorkerStepResult } from '@/lib/update-runner';

export type UpdateWorkerRunStatus = 'planned' | 'blocked' | 'succeeded' | 'failed' | 'timed_out';

export interface ExecutedUpdateWorkerStep {
  id: string;
  title: string;
  command: string;
  status: UpdateWorkerRunStatus;
  result?: UpdateCommandExecutionResult;
  skippedReason?: string;
}

export interface ExecutedUpdateWorker {
  action: UpdateWorkerResult['action'];
  status: UpdateWorkerRunStatus;
  failures: string[];
  steps: ExecutedUpdateWorkerStep[];
}

export interface ExecuteUpdateWorkerOptions extends Pick<ExecutePreparedUpdateCommandOptions, 'maxOutputBytes'> {
  mode: UpdateCommandExecutionMode;
  onEvent?: (event: UpdateCommandExecutionEvent) => void | Promise<void>;
}

export async function executeUpdateWorker(
  worker: UpdateWorkerResult,
  options: ExecuteUpdateWorkerOptions
): Promise<ExecutedUpdateWorker> {
  if (worker.status === 'locked') {
    return {
      action: worker.action,
      status: 'blocked',
      failures: worker.failures,
      steps: worker.steps.map((step) => blockedStep(step, step.skippedReason ?? worker.failures[0])),
    };
  }

  if (options.mode !== 'execute') {
    return {
      action: worker.action,
      status: 'planned',
      failures: [],
      steps: worker.steps.map((step) => ({
        id: step.id,
        title: step.title,
        command: step.command,
        status: 'planned',
      })),
    };
  }

  const steps: ExecutedUpdateWorkerStep[] = [];
  const failures: string[] = [];

  for (const step of worker.steps) {
    if (step.status === 'blocked' || !step.descriptor) {
      const skippedReason = step.skippedReason ?? 'Worker step is blocked or missing a command descriptor.';
      failures.push(`${step.id}: ${skippedReason}`);
      steps.push(blockedStep(step, skippedReason));
      break;
    }

    const result = await executePreparedUpdateCommand(step.descriptor, 'execute', {
      maxOutputBytes: options.maxOutputBytes,
      onEvent: options.onEvent,
    });
    const status = mapCommandStatus(result.status);
    steps.push({
      id: step.id,
      title: step.title,
      command: step.command,
      status,
      result,
    });

    if (status !== 'succeeded') {
      failures.push(`${step.id}: ${result.reason ?? result.status}`);
      break;
    }
  }

  return {
    action: worker.action,
    status: failures.length > 0 ? steps.at(-1)?.status ?? 'failed' : 'succeeded',
    failures,
    steps,
  };
}

function blockedStep(step: UpdateWorkerStepResult, skippedReason?: string): ExecutedUpdateWorkerStep {
  return {
    id: step.id,
    title: step.title,
    command: step.command,
    status: 'blocked',
    skippedReason,
  };
}

function mapCommandStatus(status: UpdateCommandExecutionResult['status']): UpdateWorkerRunStatus {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'timed_out') return 'timed_out';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}
