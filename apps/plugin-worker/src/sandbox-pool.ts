/**
 * A small pool of executor threads for the QuickJS sandbox (ADR-007).
 *
 * Why threads, when QuickJS already isolates the plugin: the QuickJS
 * interrupt handler is checked between bytecodes, so one long native
 * operation inside the VM (measured: `sort()` on 200 000 numbers in a loop
 * ran 298 s past a 300 ms deadline) can hold the calling thread far beyond
 * the budget. Run in the worker's main thread, that would freeze every
 * plugin and the health check. Here each call runs in a pooled thread; if
 * the thread has not answered by `budgetMs + killGraceMs`, it is
 * terminated (V8 stops running WebAssembly within milliseconds) and
 * replaced. A plugin can therefore cost at most one thread for one budget,
 * and never takes the worker down.
 *
 * Inside the thread every call gets a fresh QuickJS WebAssembly instance
 * (sandbox-core.mjs). The thread itself is not a security boundary — the
 * WebAssembly sandbox is; the container (read-only fs, no capabilities,
 * pids/memory caps, a network only the web app joins) is the outer layer.
 * The old per-call child process (ADR-001) is gone: plugin code no longer
 * runs as Node, so it has no process, file system or environment to reach.
 */
import { Worker } from 'node:worker_threads';

export type SandboxOp =
  | 'describe'
  | 'createInitialState'
  | 'handleAction'
  | 'validateAction'
  | 'projectState'
  | 'migrateState';

export interface SandboxLimits {
  /** Interrupt deadline inside the VM, from the start of the call. */
  budgetMs: number;
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** QuickJS stack limit. */
  stackBytes: number;
  /** Cap on the output JSON, in UTF-8 bytes. */
  maxOutputBytes: number;
}

export interface SandboxJob {
  /** server.js */
  source: string;
  /** JSON: { op, ctx?, state?, action?, viewerId?, raw?, random? } */
  input: string;
}

export type SandboxFailureKind = 'timeout' | 'memory' | 'stack' | 'output' | 'error' | 'crash' | 'busy';

export type SandboxResult = { ok: true; output: string } | { ok: false; kind: SandboxFailureKind; error: string };

export interface SandboxPoolOptions {
  size: number;
  limits: SandboxLimits;
  /** Extra time after the budget before the thread is terminated. */
  killGraceMs: number;
  /** Calls waiting for a thread beyond this are refused as busy. */
  maxQueue: number;
  /** A call that waited this long for a thread is refused as busy. */
  queueTimeoutMs: number;
  /** For tests: an alternative thread entry. */
  threadUrl?: URL;
}

interface Pending {
  id: number;
  resolve: (result: SandboxResult) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  busy: Pending | null;
}

interface Queued {
  job: SandboxJob;
  resolve: (result: SandboxResult) => void;
  enqueuedAt: number;
}

const FAILURE_KINDS = new Set<SandboxFailureKind>(['timeout', 'memory', 'stack', 'output', 'error', 'crash', 'busy']);

/** Accept only the two result shapes a thread may send. */
function readThreadResult(raw: unknown): SandboxResult {
  if (raw && typeof raw === 'object') {
    const r = raw as { ok?: unknown; output?: unknown; kind?: unknown; error?: unknown };
    if (r.ok === true && typeof r.output === 'string') return { ok: true, output: r.output };
    if (r.ok === false && typeof r.kind === 'string' && FAILURE_KINDS.has(r.kind as SandboxFailureKind)) {
      return { ok: false, kind: r.kind as SandboxFailureKind, error: String(r.error ?? '').slice(0, 500) };
    }
  }
  return { ok: false, kind: 'crash', error: 'sandbox thread sent an invalid result' };
}

export class SandboxPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Queued[] = [];
  private nextId = 1;
  private closed = false;
  private readonly threadUrl: URL;

  constructor(private readonly options: SandboxPoolOptions) {
    this.threadUrl = options.threadUrl ?? new URL('./sandbox-thread.mjs', import.meta.url);
  }

  get limits(): SandboxLimits {
    return this.options.limits;
  }

  /** Run one job. Never rejects: every failure is a result. */
  run(job: SandboxJob): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve) => {
      if (this.closed) {
        resolve({ ok: false, kind: 'busy', error: 'plugin sandbox is shutting down' });
        return;
      }
      if (this.queue.length >= this.options.maxQueue) {
        resolve({ ok: false, kind: 'busy', error: 'plugin sandbox is busy, try again' });
        return;
      }
      this.queue.push({ job, resolve, enqueuedAt: Date.now() });
      this.pump();
    });
  }

  stats(): { threads: number; ready: number; busy: number; queued: number } {
    return {
      threads: this.slots.length,
      ready: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      queued.resolve({ ok: false, kind: 'busy', error: 'plugin sandbox is shutting down' });
    }
    await Promise.all(
      this.slots.splice(0).map((slot) => {
        if (slot.busy) {
          clearTimeout(slot.busy.timer);
          slot.busy.resolve({ ok: false, kind: 'busy', error: 'plugin sandbox is shutting down' });
          slot.busy = null;
        }
        return slot.worker.terminate().catch(() => 0);
      })
    );
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (Date.now() - head.enqueuedAt > this.options.queueTimeoutMs) {
        this.queue.shift();
        head.resolve({ ok: false, kind: 'busy', error: 'plugin sandbox is busy, try again' });
        continue;
      }
      const slot = this.slots.find((s) => s.ready && !s.busy);
      if (!slot) {
        if (this.slots.length < this.options.size) this.spawn();
        return;
      }
      this.queue.shift();
      this.dispatch(slot, head);
    }
  }

  private spawn(): void {
    const worker = new Worker(this.threadUrl, {
      // No environment at all: nothing to read even for a VM escape.
      env: {},
      // The thread's own JS heap (QuickJS memory is WebAssembly memory,
      // capped per call by the runtime's memory limit).
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const slot: Slot = { worker, ready: false, busy: null };
    this.slots.push(slot);

    worker.on('message', (message: unknown) => {
      const msg = (message && typeof message === 'object' ? message : {}) as { ready?: unknown; id?: unknown; result?: unknown };
      if (msg.ready === true) {
        slot.ready = true;
        this.pump();
        return;
      }
      const pending = slot.busy;
      if (!pending || msg.id !== pending.id) return;
      clearTimeout(pending.timer);
      slot.busy = null;
      pending.resolve(readThreadResult(msg.result));
      this.pump();
    });
    const onDeath = (reason: string) => {
      const index = this.slots.indexOf(slot);
      if (index === -1) return; // already retired
      this.slots.splice(index, 1);
      const pending = slot.busy;
      slot.busy = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, kind: 'crash', error: `sandbox thread died: ${reason}`.slice(0, 500) });
      }
      if (!slot.ready) {
        // Died before it could start: fail what is waiting instead of
        // respawning in a loop; the next call tries again.
        for (const queued of this.queue.splice(0)) {
          queued.resolve({ ok: false, kind: 'crash', error: `plugin sandbox could not start: ${reason}`.slice(0, 500) });
        }
        return;
      }
      this.pump();
    };
    worker.on('error', (err) => onDeath(err.message));
    worker.on('exit', (code) => onDeath(`exit code ${code}`));
  }

  private dispatch(slot: Slot, queued: Queued): void {
    const id = this.nextId++;
    const { limits, killGraceMs } = this.options;
    const timer = setTimeout(() => {
      if (slot.busy?.id !== id) return;
      slot.busy = null;
      const index = this.slots.indexOf(slot);
      if (index !== -1) this.slots.splice(index, 1);
      void slot.worker.terminate().catch(() => 0);
      queued.resolve({ ok: false, kind: 'timeout', error: 'plugin call exceeded its execution budget (thread terminated)' });
      this.pump();
    }, limits.budgetMs + killGraceMs);
    timer.unref();
    slot.busy = { id, resolve: queued.resolve, timer };
    slot.worker.postMessage({ id, job: { ...queued.job, ...limits } });
  }
}
