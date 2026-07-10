import { describe, expect, it } from 'vitest';
import {
  executePreparedUpdateCommand,
  type UpdateCommandDescriptor,
  type UpdateCommandExecutionEvent,
} from '@/lib/update-command-executor';

function testDescriptor(args: string[], timeoutMs = 5_000): UpdateCommandDescriptor {
  return {
    stepId: 'test-step',
    command: 'node test command',
    executable: process.execPath,
    args,
    cwd: 'workspace',
    shell: false,
    timeoutMs,
  };
}

describe('update command executor', () => {
  it('executes a prepared descriptor without shell and captures bounded output', async () => {
    const events: UpdateCommandExecutionEvent[] = [];
    const result = await executePreparedUpdateCommand(
      testDescriptor(['-e', 'console.log("hello update")']),
      'execute',
      {
        maxOutputBytes: 1024,
        onEvent: (event) => {
          events.push(event);
        },
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.stdout).toContain('hello update');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
    expect(events.map((event) => event.message)).toContain('Update command started.');
    expect(events.map((event) => event.message)).toContain('Update command finished.');
    const stdoutEvent = events.find((event) => event.message === 'stdout');
    expect(stdoutEvent?.metadata).toMatchObject({ truncated: false });
    expect(stdoutEvent?.metadata).not.toHaveProperty('chunk');
  });

  it('marks non-zero exits as failed', async () => {
    const result = await executePreparedUpdateCommand(
      testDescriptor(['-e', 'console.error("nope"); process.exit(7)']),
      'execute'
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('nope');
  });

  it('times out long-running commands', async () => {
    const result = await executePreparedUpdateCommand(
      testDescriptor(['-e', 'setTimeout(() => console.log("late"), 1000)'], 50),
      'execute'
    );

    expect(result.status).toBe('timed_out');
  });

  it('limits captured output', async () => {
    const result = await executePreparedUpdateCommand(
      testDescriptor(['-e', 'console.log("abcdefghij")']),
      'execute',
      { maxOutputBytes: 4 }
    );

    expect(result.status).toBe('succeeded');
    expect(result.stdout).toBe('abcd');
    expect(result.truncated).toBe(true);
  });
});
