import { describe, expect, it } from 'vitest';
import type { UpdateCommandDescriptor } from '@/lib/update-command-executor';
import {
  executeUpdateWorkerWithEvents,
  recordUpdatePreviewEvents,
  type UpdateWorkerEventRecord,
} from '@/lib/update-worker-events';
import type { UpdateWorkerResult, UpdateWorkerStepResult } from '@/lib/update-runner';

function descriptor(stepId: string, args: string[]): UpdateCommandDescriptor {
  return {
    stepId,
    command: `node ${stepId}`,
    executable: process.execPath,
    args,
    cwd: 'workspace',
    shell: false,
    timeoutMs: 5_000,
  };
}

function workerStep(id: string, args: string[]): UpdateWorkerStepResult {
  return {
    id,
    title: id,
    command: `node ${id}`,
    allowed: true,
    descriptor: descriptor(id, args),
    status: 'planned',
  };
}

function worker(steps: UpdateWorkerStepResult[]): UpdateWorkerResult {
  return {
    action: 'apply',
    executable: false,
    failures: [],
    status: 'planned',
    steps,
  };
}

describe('update worker events', () => {
  it('records preview summary and step events', async () => {
    const events: UpdateWorkerEventRecord[] = [];

    await recordUpdatePreviewEvents((event) => {
      events.push(event);
    }, {
      action: 'dry-run',
      status: 'planned',
      failureCount: 0,
      stepCount: 1,
      worker: worker([workerStep('one', ['-e', 'console.log("one")'])]),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ level: 'info', message: 'Update dry-run planned.' });
    expect(events[1]).toMatchObject({ stepId: 'one', message: 'Update worker step planned.' });
  });

  it('records execution lifecycle and command events', async () => {
    const events: UpdateWorkerEventRecord[] = [];

    const result = await executeUpdateWorkerWithEvents(worker([workerStep('one', ['-e', 'console.log("one")'])]), {
      mode: 'execute',
      recordEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe('succeeded');
    expect(events.map((event) => event.message)).toContain('Update worker execution requested.');
    expect(events.map((event) => event.message)).toContain('Update command started.');
    expect(events.map((event) => event.message)).toContain('Update worker execution finished.');
  });

  it('records accepted execution preview events distinctly from locked previews', async () => {
    const events: UpdateWorkerEventRecord[] = [];

    await recordUpdatePreviewEvents((event) => {
      events.push(event);
    }, {
      action: 'apply',
      status: 'running',
      failureCount: 0,
      stepCount: 1,
      worker: worker([workerStep('one', ['-e', 'console.log("one")'])]),
    });

    expect(events[0]).toMatchObject({
      level: 'info',
      message: 'Update execution accepted by safety gates.',
    });
  });
});
