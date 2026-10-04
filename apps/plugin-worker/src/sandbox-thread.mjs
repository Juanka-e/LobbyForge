// @ts-check
/**
 * One sandbox executor thread (owned by sandbox-pool.ts).
 *
 * Receives `{ id, job }`, runs it with a fresh QuickJS instance
 * (sandbox-core.mjs) and answers `{ id, result }`. One job at a time: the
 * pool never sends a second job before the answer. The pool terminates
 * this thread when a job overruns its hard deadline, so nothing here needs
 * to guard against a stuck job.
 *
 * Started with an EMPTY environment (`env: {}`); it holds no secrets and
 * makes no network or file access beyond reading the QuickJS .wasm file.
 */
import { parentPort } from 'node:worker_threads';
import { runInSandbox, warmUp } from './sandbox-core.mjs';

if (!parentPort) throw new Error('sandbox-thread.mjs must run as a worker thread');
const port = parentPort;

await warmUp();

port.on('message', async (message) => {
  const id = message && typeof message === 'object' ? message.id : undefined;
  const job = message && typeof message === 'object' ? message.job : undefined;
  if (typeof id !== 'number' || !job || typeof job !== 'object') return;
  const result = await runInSandbox(job);
  port.postMessage({ id, result });
});

port.postMessage({ ready: true });
