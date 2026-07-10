import type { UpdateCommandExecutionMode } from '@/lib/update-command-executor';
import type { UpdateExecutionPreview, UpdateWorkerResult } from '@/lib/update-runner';

export interface UpdateExecutionPolicyInput {
  preview: UpdateExecutionPreview;
  worker: UpdateWorkerResult;
  requestedExecution?: boolean;
}

export interface UpdateExecutionPolicy {
  mode: UpdateCommandExecutionMode;
  allowed: boolean;
  failures: string[];
}

export function buildUpdateExecutionPolicy(input: UpdateExecutionPolicyInput): UpdateExecutionPolicy {
  if (input.preview.action === 'dry-run') {
    return {
      mode: 'dry-run',
      allowed: true,
      failures: [],
    };
  }

  const failures = [
    input.requestedExecution === true ? undefined : 'Execution request was not explicitly enabled for this call.',
    input.preview.failures.length > 0 ? input.preview.failures : undefined,
    input.worker.status === 'planned' ? undefined : input.worker.failures,
  ]
    .flat()
    .filter((item): item is string => Boolean(item));

  return {
    mode: failures.length > 0 ? 'disabled' : 'execute',
    allowed: failures.length === 0,
    failures,
  };
}
