import { describe, expect, it } from 'vitest';
import type { UpdateCommandDescriptor } from '@/lib/update-command-executor';
import { executeUpdateWorker } from '@/lib/update-worker';
import type { UpdateWorkerResult, UpdateWorkerStepResult } from '@/lib/update-runner';

function descriptor(stepId: string, args: string[], timeoutMs = 5_000): UpdateCommandDescriptor {
  return {
    stepId,
    command: `node ${stepId}`,
    executable: process.execPath,
    args,
    cwd: 'workspace',
    shell: false,
    timeoutMs,
  };
}

function step(id: string, args: string[]): UpdateWorkerStepResult {
  return {
    id,
    title: id,
    command: `node ${id}`,
    allowed: true,
    descriptor: descriptor(id, args),
    status: 'planned',
  };
}

function worker(steps: UpdateWorkerStepResult[], status: UpdateWorkerResult['status'] = 'planned'): UpdateWorkerResult {
  return {
    action: 'apply',
    executable: false,
    failures: status === 'locked' ? ['locked for test'] : [],
    status,
    steps,
  };
}

describe('update worker orchestration', () => {
  it('keeps planned workers as planned outside execute mode', async () => {
    const result = await executeUpdateWorker(worker([step('one', ['-e', 'console.log("one")'])]), {
      mode: 'dry-run',
    });

    expect(result.status).toBe('planned');
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: 'one',
        status: 'planned',
      }),
    ]);
  });

  it('does not execute locked workers', async () => {
    const result = await executeUpdateWorker(worker([step('one', ['-e', 'console.log("one")'])], 'locked'), {
      mode: 'execute',
    });

    expect(result.status).toBe('blocked');
    expect(result.steps[0]).toMatchObject({ id: 'one', status: 'blocked' });
  });

  it('executes planned steps sequentially', async () => {
    const events: string[] = [];
    const result = await executeUpdateWorker(
      worker([
        step('one', ['-e', 'console.log("one")']),
        step('two', ['-e', 'console.log("two")']),
      ]),
      {
        mode: 'execute',
        onEvent: (event) => {
          if (event.message === 'Update command started.') events.push(event.stepId);
        },
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.steps.map((item) => item.status)).toEqual(['succeeded', 'succeeded']);
    expect(events).toEqual(['one', 'two']);
  });

  it('stops on the first failed step', async () => {
    const result = await executeUpdateWorker(
      worker([
        step('one', ['-e', 'process.exit(9)']),
        step('two', ['-e', 'console.log("two")']),
      ]),
      { mode: 'execute' }
    );

    expect(result.status).toBe('failed');
    expect(result.failures[0]).toContain('one');
    expect(result.steps).toHaveLength(1);
  });
});
