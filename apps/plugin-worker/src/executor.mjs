/**
 * Untrusted plugin EXECUTOR (plain JS — worker_threads cannot run TS).
 * Runs inside a worker_thread spawned with env:{} (no worker secrets
 * are readable), resourceLimits, and terminate() on timeout. See
 * src/index.ts runInExecutorThread for the isolation contract.
 */
/**
 * Untrusted plugin EXECUTOR thread (9th-audit findings 4+5).
 *
 * This file runs inside a worker_thread spawned with:
 *   - env: {}               → process.env is EMPTY — the plugin cannot
 *                             read ANY worker secret (RPC token, host
 *                             origin, tokens of any kind);
 *   - resourceLimits        → heap/stack caps;
 *   - terminate() on timeout→ a `while(true)` plugin is KILLED, not
 *                             merely out-raced (Promise timeouts cannot
 *                             fire while the event loop is blocked).
 *
 * It imports the plugin bundle, builds the snapshot ctx and runs ONE
 * op, posting the result back to the parent. Storage capability calls
 * are forwarded over the parent port — the thread performs them via
 * the per-call SCOPED capability passed in workerData, never a global
 * secret.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';


const data = workerData;

function post(message) {
  parentPort?.postMessage(message);
}

async function storageOp(op, args) {
  const res = await fetch(data.storageEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Scoped capability — bound to (serverId, pluginId, short TTL) by
      // the HOST's HMAC; worthless for any other keyspace.
      'x-lf-plugin-capability': data.storageCapability,
    },
    body: JSON.stringify({ op, ...args }),
  });
  if (!res.ok) throw new Error(`plugin-storage ${op} failed: HTTP ${res.status}`);
  return res.json();
}

function buildCtx() {
  const env = data.ctx;
  return {
    actorUserId: env.actorUserId,
    players: {
      list: () => env.players.map((p) => p.id),
      get: (playerId) => env.players.find((p) => p.id === playerId),
    },
    messages: {
      sendGameMessage: async (message) => {
        post({ log: `${env.pluginId}@${env.serverId}: ${message}` });
      },
    },
    state: {
      save: async (_state) => {
        /* host persists the returned state after the call */
      },
    },
    cache: {
      get: async () => undefined,
      set: async () => undefined,
    },
    pubsub: {
      publish: async () => undefined,
      subscribe: async () => undefined,
    },
    timer: {
      start: async () => undefined,
      stop: async () => undefined,
    },
    votes: {
      create: async () => undefined,
    },
    scores: {
      add: async () => undefined,
    },
    voice: {
      getParticipants: () => env.voiceParticipants,
    },
    storage: {
      get: async (key) =>
        (await storageOp('get', { key, serverId: env.serverId, pluginId: env.pluginId })).value,
      set: async (key, value) =>
        void (await storageOp('set', { key, value, serverId: env.serverId, pluginId: env.pluginId })),
      delete: async (key) =>
        Boolean(
          (await storageOp('delete', { key, serverId: env.serverId, pluginId: env.pluginId })).deleted
        ),
      list: async () =>
        (await storageOp('list', { serverId: env.serverId, pluginId: env.pluginId })).items,
      clear: async () => void (await storageOp('clear', { serverId: env.serverId, pluginId: env.pluginId })),
    },
  };
}

void (async () => {
  try {
    const mod = (await import(pathToFileURL(data.pluginPath).href));
    const raw = mod?.plugin ?? mod?.default;
    if (!raw || typeof raw !== 'object') {
      post({ error: 'plugin bundle has no export' });
      return;
    }
    const plugin = raw;

    let result;
    if (data.op === 'describe') {
      // Manifest probe ONLY — used by the parent for the plugin list.
      // Runs here, in the disposable thread, precisely so the parent
      // NEVER import()s untrusted code (10th-audit finding 2).
      result = {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version ?? null,
      };
    } else if (data.op === 'createInitialState') {
      result = await plugin.createInitialState(buildCtx());
    } else if (data.op === 'handleAction') {
      result = await plugin.handleAction(buildCtx(), data.state, data.action);
    } else {
      result = plugin.migrateState ? await plugin.migrateState(data.raw) : data.raw;
    }
    post({ result: result ?? null });
  } catch (err) {
    post({ error: err && err.message ? err.message : String(err) });
  }
})();
