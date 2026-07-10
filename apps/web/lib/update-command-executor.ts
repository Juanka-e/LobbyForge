import type { UpdateExecutionAction } from '@/lib/update-runner';

export type UpdateCommandExecutionMode = 'disabled' | 'dry-run' | 'execute';

export interface UpdateCommandDescriptor {
  stepId: string;
  command: string;
  executable: string;
  args: string[];
  cwd: 'workspace';
  shell: false;
  timeoutMs: number;
}

export interface UpdateCommandPreparation {
  ok: boolean;
  descriptor?: UpdateCommandDescriptor;
  reason?: string;
}

export interface UpdateCommandExecutionResult {
  status: 'blocked' | 'succeeded' | 'failed' | 'timed_out';
  descriptor?: UpdateCommandDescriptor;
  reason?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  truncated?: boolean;
}

export interface UpdateCommandExecutionEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  stepId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutePreparedUpdateCommandOptions {
  maxOutputBytes?: number;
  onEvent?: (event: UpdateCommandExecutionEvent) => void | Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

const COMMAND_DESCRIPTORS: Record<string, ReadonlyArray<Omit<UpdateCommandDescriptor, 'stepId'>>> = {
  'preflight-doctor': [
    {
      command: 'lfctl doctor',
      executable: 'pnpm',
      args: ['lfctl', 'doctor'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ],
  backup: [
    {
      command: 'lfctl backup create',
      executable: 'pnpm',
      args: ['lfctl', 'backup', 'create'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ],
  'pull-images': [
    {
      command: 'docker compose pull',
      executable: 'docker',
      args: ['compose', 'pull'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: 300_000,
    },
  ],
  'migration-dry-run': [
    {
      command: 'pnpm --filter @lobbyforge/db db:generate -- --dry-run',
      executable: 'pnpm',
      args: ['--filter', '@lobbyforge/db', 'db:generate', '--', '--dry-run'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ],
  'apply-migrations': [
    {
      command: 'pnpm --filter @lobbyforge/db db:migrate',
      executable: 'pnpm',
      args: ['--filter', '@lobbyforge/db', 'db:migrate'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ],
  'recreate-services': [
    {
      command: 'docker compose up -d --remove-orphans',
      executable: 'docker',
      args: ['compose', 'up', '-d', '--remove-orphans'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: 300_000,
    },
  ],
  'health-check': [
    {
      command: 'curl -fsS http://localhost:3000/api/health',
      executable: 'curl',
      args: ['-fsS', 'http://localhost:3000/api/health'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: 30_000,
    },
  ],
  rollback: [
    {
      command: 'docker compose up -d --remove-orphans',
      executable: 'docker',
      args: ['compose', 'up', '-d', '--remove-orphans'],
      cwd: 'workspace',
      shell: false,
      timeoutMs: 300_000,
    },
  ],
};

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function getUpdateCommandDescriptors(stepId: string): UpdateCommandDescriptor[] {
  return (COMMAND_DESCRIPTORS[stepId] ?? []).map((descriptor) => ({
    ...descriptor,
    stepId,
  }));
}

export function isUpdateCommandAllowlisted(stepId: string, command: string): boolean {
  const normalized = normalizeCommand(command);
  return getUpdateCommandDescriptors(stepId).some((descriptor) => descriptor.command === normalized);
}

export function prepareUpdateCommand(stepId: string, command: string): UpdateCommandPreparation {
  const normalized = normalizeCommand(command);
  const descriptor = getUpdateCommandDescriptors(stepId).find((item) => item.command === normalized);

  if (!descriptor) {
    return {
      ok: false,
      reason: 'Command is not in the update runner allowlist.',
    };
  }

  return {
    ok: true,
    descriptor,
  };
}

export function getUpdateCommandExecutionMode(action: UpdateExecutionAction): UpdateCommandExecutionMode {
  return action === 'dry-run' ? 'dry-run' : 'disabled';
}

export async function executePreparedUpdateCommand(
  descriptor: UpdateCommandDescriptor,
  mode: UpdateCommandExecutionMode,
  options: ExecutePreparedUpdateCommandOptions = {}
): Promise<UpdateCommandExecutionResult> {
  if (mode !== 'execute') {
    return {
      status: 'blocked',
      descriptor,
      reason:
        mode === 'disabled'
          ? 'Command executor is disabled.'
          : 'Dry-run mode only prepares the allowlisted command descriptor.',
    };
  }

  const { spawn } = await import('node:child_process');
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;

  await emitExecutionEvent(options, {
    level: 'info',
    stepId: descriptor.stepId,
    message: 'Update command started.',
    metadata: {
      executable: descriptor.executable,
      args: descriptor.args,
      timeoutMs: descriptor.timeoutMs,
    },
  });

  return new Promise<UpdateCommandExecutionResult>((resolve) => {
    const child = spawn(descriptor.executable, descriptor.args, {
      cwd: descriptor.cwd === 'workspace' ? process.cwd() : undefined,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      void emitExecutionEvent(options, {
        level: 'error',
        stepId: descriptor.stepId,
        message: 'Update command timed out.',
        metadata: { timeoutMs: descriptor.timeoutMs },
      });
      child.kill('SIGTERM');
    }, descriptor.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const result = appendBounded(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = result.text;
      stdoutBytes = result.bytes;
      truncated ||= result.truncated;
      void emitExecutionEvent(options, {
        level: 'debug',
        stepId: descriptor.stepId,
        message: 'stdout',
        metadata: { bytes: chunk.byteLength, acceptedBytes: result.acceptedBytes, truncated: result.truncated },
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const result = appendBounded(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = result.text;
      stderrBytes = result.bytes;
      truncated ||= result.truncated;
      void emitExecutionEvent(options, {
        level: 'warn',
        stepId: descriptor.stepId,
        message: 'stderr',
        metadata: { bytes: chunk.byteLength, acceptedBytes: result.acceptedBytes, truncated: result.truncated },
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      void emitExecutionEvent(options, {
        level: 'error',
        stepId: descriptor.stepId,
        message: 'Update command failed to start.',
        metadata: { error: err.message },
      });
      resolve({
        status: 'failed',
        descriptor,
        reason: err.message,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const status = timedOut ? 'timed_out' : exitCode === 0 ? 'succeeded' : 'failed';
      void emitExecutionEvent(options, {
        level: status === 'succeeded' ? 'info' : 'error',
        stepId: descriptor.stepId,
        message: status === 'succeeded' ? 'Update command finished.' : 'Update command failed.',
        metadata: { exitCode, signal, truncated },
      });
      resolve({
        status,
        descriptor,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    });
  });
}

function appendBounded(
  current: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number
): { text: string; bytes: number; acceptedBytes: number; truncated: boolean } {
  const remaining = Math.max(maxBytes - currentBytes, 0);
  const truncated = chunk.byteLength > remaining;
  const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
  const chunkText = accepted.toString('utf8');

  return {
    text: current + chunkText,
    bytes: currentBytes + accepted.byteLength,
    acceptedBytes: accepted.byteLength,
    truncated,
  };
}

async function emitExecutionEvent(
  options: ExecutePreparedUpdateCommandOptions,
  event: UpdateCommandExecutionEvent
): Promise<void> {
  if (!options.onEvent) return;
  await options.onEvent(event);
}
