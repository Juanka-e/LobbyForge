import type { UpdateCommandExecutionEvent, UpdateCommandExecutionMode } from '@/lib/update-command-executor';
import { executeUpdateWorker, type ExecutedUpdateWorker } from '@/lib/update-worker';
import type { UpdateExecutionAction, UpdateWorkerResult } from '@/lib/update-runner';

export interface UpdateWorkerEventRecord {
  stepId?: string | null;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
}

export type UpdateWorkerEventRecorder = (event: UpdateWorkerEventRecord) => void | Promise<void>;

export interface RecordPreviewEventsInput {
  action: UpdateExecutionAction;
  status: string;
  failureCount: number;
  stepCount: number;
  worker: UpdateWorkerResult;
}

export async function recordUpdatePreviewEvents(
  recordEvent: UpdateWorkerEventRecorder,
  input: RecordPreviewEventsInput
): Promise<void> {
  await recordEvent({
    level: input.failureCount > 0 ? 'warn' : 'info',
    message: previewSummaryMessage(input.action, input.status),
    metadata: {
      action: input.action,
      status: input.status,
      failureCount: input.failureCount,
      stepCount: input.stepCount,
    },
  });

  for (const step of input.worker.steps) {
    const metadata: Record<string, unknown> = { command: step.command };
    if (step.descriptor) metadata.descriptor = step.descriptor;
    if (step.skippedReason) metadata.skippedReason = step.skippedReason;

    await recordEvent({
      stepId: step.id,
      level: step.status === 'planned' ? 'info' : 'warn',
      message: step.status === 'planned' ? 'Update worker step planned.' : 'Update worker step blocked.',
      metadata,
    });
  }
}

function previewSummaryMessage(action: UpdateExecutionAction, status: string): string {
  if (action === 'dry-run') return 'Update dry-run planned.';
  if (status === 'running') return 'Update execution accepted by safety gates.';
  return 'Update execution locked by safety gates.';
}

export interface ExecuteWorkerWithEventsOptions {
  mode: UpdateCommandExecutionMode;
  maxOutputBytes?: number;
  recordEvent: UpdateWorkerEventRecorder;
}

export async function executeUpdateWorkerWithEvents(
  worker: UpdateWorkerResult,
  options: ExecuteWorkerWithEventsOptions
): Promise<ExecutedUpdateWorker> {
  await options.recordEvent({
    level: options.mode === 'execute' ? 'info' : 'debug',
    message: 'Update worker execution requested.',
    metadata: {
      action: worker.action,
      mode: options.mode,
      workerStatus: worker.status,
      stepCount: worker.steps.length,
    },
  });

  const result = await executeUpdateWorker(worker, {
    mode: options.mode,
    maxOutputBytes: options.maxOutputBytes,
    onEvent: async (event) => {
      await options.recordEvent(commandEventToRecord(event));
    },
  });

  await options.recordEvent({
    level: result.status === 'succeeded' || result.status === 'planned' ? 'info' : 'error',
    message: 'Update worker execution finished.',
    metadata: {
      action: result.action,
      status: result.status,
      failureCount: result.failures.length,
      executedStepCount: result.steps.length,
    },
  });

  return result;
}

function commandEventToRecord(event: UpdateCommandExecutionEvent): UpdateWorkerEventRecord {
  return {
    stepId: event.stepId,
    level: event.level,
    message: event.message,
    metadata: event.metadata,
  };
}
