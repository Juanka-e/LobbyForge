/**
 * The executor-thread pool around the QuickJS sandbox (sandbox-pool.ts):
 * the hard wall-clock kill for work the VM interrupt cannot stop, the
 * memory limit, the queue limit, and what happens when a thread dies.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxPool, type SandboxLimits } from '../sandbox-pool.js';

const LIMITS: SandboxLimits = {
  budgetMs: 800,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
};

const pools: SandboxPool[] = [];
function makePool(overrides: Partial<ConstructorParameters<typeof SandboxPool>[0]> = {}): SandboxPool {
  const pool = new SandboxPool({ size: 2, limits: LIMITS, killGraceMs: 200, maxQueue: 16, queueTimeoutMs: 10_000, ...overrides });
  pools.push(pool);
  return pool;
}

const plugin = (createBody: string) =>
  `globalThis.plugin = { createInitialState: function (ctx) { ${createBody} }, handleAction: function (c, s) { return s; } };`;
const input = (extra: Record<string, unknown> = {}) => JSON.stringify({ op: 'createInitialState', ctx: {}, random: [], ...extra });

let fixtures: string;
beforeAll(() => {
  fixtures = resolve(__dirname, '..', '..', '.plugin-fixtures', 'pool');
  rmSync(fixtures, { recursive: true, force: true });
  mkdirSync(fixtures, { recursive: true });
  // A thread entry that dies before it is ready.
  writeFileSync(join(fixtures, 'broken-thread.mjs'), "throw new Error('cannot start');\n");
  // A thread entry that becomes ready, then exits on its first job.
  writeFileSync(
    join(fixtures, 'dying-thread.mjs'),
    "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => process.exit(3));\nparentPort.postMessage({ ready: true });\n"
  );
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
  rmSync(fixtures, { recursive: true, force: true });
});

describe('SandboxPool', () => {
  it('runs a job and returns the JSON envelope', async () => {
    const pool = makePool();
    const result = await pool.run({ source: plugin('return { hello: "world" };'), input: input() });
    expect(result).toEqual({ ok: true, output: '{"r":{"hello":"world"}}' });
  });

  it('runs jobs on several threads at once, up to its size', async () => {
    const pool = makePool({ size: 2 });
    const busy = plugin('var end = ctx.until; while (Date.now() < end) {} return { done: true };');
    const until = Date.now() + 300;
    const results = await Promise.all([
      pool.run({ source: busy, input: input({ ctx: { until } }) }),
      pool.run({ source: busy, input: input({ ctx: { until } }) }),
      pool.run({ source: busy, input: input({ ctx: { until } }) }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(pool.stats().threads).toBe(2);
  });

  it('a memory bomb fails with the memory limit, not the worker', async () => {
    const pool = makePool({ limits: { ...LIMITS, budgetMs: 5_000 } });
    const result = await pool.run({
      // Small objects in a tight loop reach the 32 MB limit after a few
      // hundred thousand cheap iterations — fast enough that the memory
      // limit, not the time budget, stops it even when the whole monorepo's
      // tests are hogging the CPU (filling 1M-element arrays in the
      // interpreter could outlast the budget under load; doubling a string
      // hits QuickJS's string-length cap first).
      source: plugin('var a = []; while (true) a.push({ i: a.length, s: "padding-padding-padding" }); '),
      input: input(),
    });
    expect(result).toMatchObject({ ok: false, kind: 'memory' });
    const after = await pool.run({ source: plugin('return { ok: 1 };'), input: input() });
    expect(after.ok).toBe(true);
  }, 20_000);

  it('kills a thread that overruns the budget in native code, then serves the next job', async () => {
    const pool = makePool({ size: 1 });
    const started = Date.now();
    const result = await pool.run({
      source: plugin('var a = []; for (var i = 0; i < 200000; i++) a.push(-i); while (true) a.sort();'),
      input: input(),
    });
    expect(result).toEqual({ ok: false, kind: 'timeout', error: 'plugin call exceeded its execution budget (thread terminated)' });
    expect(Date.now() - started).toBeLessThan(LIMITS.budgetMs + 2_000);
    const next = await pool.run({ source: plugin('return { alive: true };'), input: input() });
    expect(next).toEqual({ ok: true, output: '{"r":{"alive":true}}' });
  }, 20_000);

  it('refuses work beyond its queue as busy', async () => {
    const pool = makePool({ size: 1, maxQueue: 1 });
    const slow = plugin('var end = Date.now() + 300; while (Date.now() < end) {} return {};');
    const first = pool.run({ source: slow, input: input() }); // waits for the thread to start: queued
    const second = await pool.run({ source: slow, input: input() });
    expect(second).toMatchObject({ ok: false, kind: 'busy' });
    expect((await first).ok).toBe(true);
  }, 20_000);

  it('a thread that dies mid-job fails that job and is replaced', async () => {
    const pool = makePool({ size: 1, threadUrl: pathToFileURL(join(fixtures, 'dying-thread.mjs')) });
    const result = await pool.run({ source: '', input: input() });
    expect(result).toMatchObject({ ok: false, kind: 'crash' });
    expect(pool.stats().threads).toBe(0);
  });

  it('a thread that cannot start fails the waiting jobs instead of respawning in a loop', async () => {
    const pool = makePool({ size: 2, threadUrl: pathToFileURL(join(fixtures, 'broken-thread.mjs')) });
    const result = await pool.run({ source: '', input: input() });
    expect(result).toMatchObject({ ok: false, kind: 'crash' });
    expect(result.ok ? '' : result.error).toMatch(/could not start|died/);
    expect(pool.stats().queued).toBe(0);
  });

  it('close() settles queued work as busy', async () => {
    const pool = makePool({ size: 1 });
    const pending = pool.run({ source: plugin('var end = Date.now() + 200; while (Date.now() < end) {} return {};'), input: input() });
    const queued = pool.run({ source: plugin('return {};'), input: input() });
    await pool.close();
    expect((await queued).ok).toBe(false);
    expect((await pending).ok).toBe(false);
    expect(await pool.run({ source: plugin('return {};'), input: input() })).toMatchObject({ ok: false, kind: 'busy' });
  });
});
