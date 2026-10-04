// @ts-check
/**
 * QuickJS sandbox core (ADR-007): runs ONE operation of a marketplace
 * plugin's `server.js` and returns its JSON output.
 *
 * Plain JavaScript on purpose: a worker thread loads this file directly,
 * from dist/ in production and from src/ under vitest (Node 22 cannot load
 * TypeScript in a Worker).
 *
 * Isolation, per call:
 *  - a FRESH WebAssembly instance of QuickJS (new linear memory: nothing a
 *    previous call left in memory, including another plugin's state, is
 *    reachable even through a QuickJS bug), a fresh runtime and context;
 *  - only plain ECMAScript inside: no module loader, no host functions at
 *    all. quickjs-emscripten adds no `std`/`os` modules; the emscripten
 *    build has no Atomics or SharedArrayBuffer;
 *  - memory limit, max stack size, and an interrupt deadline. The deadline
 *    is checked by the interpreter between bytecodes, so a long native
 *    operation (a large `sort()`) can overrun it: the pool that owns the
 *    thread enforces a hard wall-clock kill on top (sandbox-pool.ts);
 *  - JSON strings are the only thing that crosses: the host passes one
 *    string in and reads one string out.
 *
 * Contract (sdk "sandbox-v1"): `server.js` assigns
 *   globalThis.plugin = { createInitialState(ctx), handleAction(ctx, state, action),
 *                         validateAction?(action), projectState?(state, viewerId, ctx),
 *                         migrateState?(raw) }
 * All functions are synchronous and return JSON-serialisable values.
 */
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

/** @type {Promise<import('quickjs-emscripten-core').QuickJSSyncVariant> | null} */
let variantPromise = null;

/** Compile the QuickJS WebAssembly module once per thread; instantiate it per call. */
function getVariant() {
  if (!variantPromise) {
    variantPromise = WebAssembly.compile(readFileSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'))).then(
      (wasmModule) => newVariant(releaseSyncVariant, { wasmModule })
    );
  }
  return variantPromise;
}

/** Compile ahead of the first call (threads call this at start-up). */
export async function warmUp() {
  await getVariant();
}

/**
 * Evaluated before server.js. Its completion value is the call function,
 * held only by the host: plugin code can neither reach nor replace it. It
 * captures the built-ins it uses before plugin code runs.
 */
const PRELUDE = `(function () {
  'use strict';
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var MathObj = Math;
  var G = globalThis;
  // No shared memory (ADR-007). QuickJS has no Atomics in this build and
  // there is no other thread to share with, but the constructor exists.
  delete G.SharedArrayBuffer;
  MathObj.random = function () {
    throw new Error('Math.random() is not available while server.js loads; use ctx.random() inside a call');
  };
  function need(plugin, name) {
    if (typeof plugin[name] !== 'function') throw new Error('plugin.' + name + ' is not a function');
    return plugin[name];
  }
  return function lfCall(inputJson) {
    var input = parse(inputJson);
    var values = input.random || [];
    var next = 0;
    var exhausted = false;
    var random = function () {
      if (next >= values.length) {
        exhausted = true;
        throw new Error('ctx.random(): the ' + values.length + ' random values the host provided for this call are used up');
      }
      return values[next++];
    };
    MathObj.random = random;
    var ctx = input.ctx || {};
    ctx.random = random;
    var plugin = G.plugin;
    if (plugin === null || typeof plugin !== 'object') {
      throw new Error('server.js must assign globalThis.plugin = { createInitialState, handleAction, ... }');
    }
    var out;
    var op = input.op;
    if (op === 'describe') {
      out = {
        createInitialState: typeof plugin.createInitialState === 'function',
        handleAction: typeof plugin.handleAction === 'function',
        validateAction: typeof plugin.validateAction === 'function',
        projectState: typeof plugin.projectState === 'function',
        migrateState: typeof plugin.migrateState === 'function'
      };
    } else if (op === 'createInitialState') {
      out = need(plugin, 'createInitialState')(ctx);
    } else if (op === 'handleAction') {
      var state = input.state;
      out = need(plugin, 'handleAction')(ctx, state, input.action);
      if (out === state) {
        if (exhausted) throw new Error('ctx.random(): the random values for this call are used up');
        return '{"u":1}';
      }
    } else if (op === 'validateAction') {
      out = typeof plugin.validateAction === 'function' ? plugin.validateAction(input.action) : null;
    } else if (op === 'projectState') {
      out = typeof plugin.projectState === 'function' ? plugin.projectState(input.state, input.viewerId, ctx) : input.state;
    } else if (op === 'migrateState') {
      out = typeof plugin.migrateState === 'function' ? plugin.migrateState(input.raw) : input.raw;
    } else {
      throw new Error('unknown op');
    }
    if (out !== null && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function') {
      throw new Error(op + ' returned a Promise: sandbox calls are synchronous');
    }
    if (exhausted) throw new Error('ctx.random(): the random values for this call are used up');
    var json = stringify({ r: out === undefined ? null : out });
    if (typeof json !== 'string') throw new Error(op + ' returned a value that is not JSON');
    return json;
  };
})()`;

/**
 * @typedef {object} SandboxJob
 * @property {string} source        server.js
 * @property {string} input         JSON: { op, ctx?, state?, action?, viewerId?, raw?, random? }
 * @property {number} budgetMs      interrupt deadline, from the start of the call
 * @property {number} memoryBytes   QuickJS heap limit
 * @property {number} stackBytes    QuickJS stack limit
 * @property {number} maxOutputBytes cap on the output JSON (UTF-8 bytes)
 */

/**
 * @typedef {{ ok: true, output: string }
 *   | { ok: false, kind: 'timeout' | 'memory' | 'stack' | 'output' | 'error' | 'crash', error: string }} SandboxResult
 */

/** One line, printable, bounded: plugin-controlled text ends up in host logs. */
function cleanMessage(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 500);
}

/**
 * Classify a QuickJS exception (already dumped to a host value).
 * @returns {SandboxResult}
 */
function classify(dumped, where) {
  const name = dumped && typeof dumped === 'object' && typeof dumped.name === 'string' ? dumped.name : '';
  const message =
    dumped && typeof dumped === 'object' && typeof dumped.message === 'string' ? dumped.message : String(dumped);
  if (name === 'InternalError' && message === 'interrupted') {
    return { ok: false, kind: 'timeout', error: 'plugin call exceeded its execution budget (interrupted)' };
  }
  if (name === 'InternalError' && message === 'out of memory') {
    return { ok: false, kind: 'memory', error: 'plugin call exceeded its memory limit' };
  }
  if ((name === 'InternalError' || name === 'RangeError') && /stack overflow/i.test(message)) {
    return { ok: false, kind: 'stack', error: 'plugin call exceeded its stack limit' };
  }
  return { ok: false, kind: 'error', error: cleanMessage(`${where}: ${name ? `${name}: ` : ''}${message}`) };
}

/**
 * Run one job. Never throws: every failure is a result.
 * @param {SandboxJob} job
 * @returns {Promise<SandboxResult>}
 */
export async function runInSandbox(job) {
  const deadline = Date.now() + job.budgetMs;
  /** @type {import('quickjs-emscripten-core').QuickJSRuntime | null} */
  let rt = null;
  /** @type {import('quickjs-emscripten-core').QuickJSContext | null} */
  let vm = null;
  /** @type {Array<{ dispose(): void, alive: boolean }>} */
  const handles = [];
  let clean = false;
  try {
    const module = await newQuickJSWASMModuleFromVariant(getVariant());
    rt = module.newRuntime();
    rt.setMemoryLimit(job.memoryBytes);
    rt.setMaxStackSize(job.stackBytes);
    rt.setInterruptHandler(() => Date.now() > deadline);
    vm = rt.newContext();

    const prelude = vm.evalCode(PRELUDE, 'lobbyforge-prelude.js');
    if (prelude.error) {
      handles.push(prelude.error);
      return { ok: false, kind: 'crash', error: 'sandbox prelude failed' };
    }
    const lfCall = prelude.value;
    handles.push(lfCall);

    const loaded = vm.evalCode(job.source, 'server.js');
    if (loaded.error) {
      handles.push(loaded.error);
      return classify(safeDump(vm, loaded.error), 'server.js');
    }
    handles.push(loaded.value);

    const arg = vm.newString(job.input);
    handles.push(arg);
    const called = vm.callFunction(lfCall, vm.undefined, arg);
    if (called.error) {
      handles.push(called.error);
      return classify(safeDump(vm, called.error), 'plugin');
    }
    const out = called.value;
    handles.push(out);
    if (vm.typeof(out) !== 'string') return { ok: false, kind: 'crash', error: 'sandbox returned a non-string' };
    // A UTF-16 length over the cap is over it in UTF-8 too: refuse before copying.
    const lengthHandle = vm.getProp(out, 'length');
    handles.push(lengthHandle);
    if (vm.getNumber(lengthHandle) > job.maxOutputBytes) {
      return { ok: false, kind: 'output', error: 'plugin result exceeds the size cap' };
    }
    const output = vm.getString(out);
    if (Buffer.byteLength(output, 'utf8') > job.maxOutputBytes) {
      return { ok: false, kind: 'output', error: 'plugin result exceeds the size cap' };
    }
    clean = true;
    return { ok: true, output };
  } catch (err) {
    // A host-level throw (the VM recursed through the native stack, or the
    // WebAssembly instance aborted): the instance is discarded below.
    const message = err && typeof err === 'object' && 'message' in err ? err.message : err;
    if (/call stack|stack overflow/i.test(String(message))) {
      return { ok: false, kind: 'stack', error: 'plugin call exceeded its stack limit' };
    }
    if (Date.now() > deadline) {
      return { ok: false, kind: 'timeout', error: 'plugin call exceeded its execution budget (interrupted)' };
    }
    return { ok: false, kind: 'crash', error: cleanMessage(`sandbox failure: ${message}`) };
  } finally {
    // Dispose in order. After a failure the runtime may be in a state where
    // QuickJS asserts on free; the whole WebAssembly instance is garbage
    // either way, so disposal errors are ignored.
    for (const handle of handles.reverse()) {
      try {
        if (handle.alive) handle.dispose();
      } catch {
        /* discarded with the instance */
      }
    }
    if (clean) {
      try {
        vm?.dispose();
        rt?.dispose();
      } catch {
        /* discarded with the instance */
      }
    }
  }
}

/** @param {import('quickjs-emscripten-core').QuickJSContext} vm */
function safeDump(vm, handle) {
  try {
    return vm.dump(handle);
  } catch {
    return { name: 'Error', message: 'unreadable error' };
  }
}
