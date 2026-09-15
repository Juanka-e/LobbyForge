// Plugin executor — CHILD PROCESS variant (15th-audit finding 5).
//
// Runs ONE plugin op in a dedicated child process (node:child_process
// fork). Unlike worker_threads (which share the same OS process and
// can read /proc/self/environ for startup env), a child process is a
// REAL OS-level boundary:
//   - its own /proc/<pid>/environ (empty — no startup env leakage);
//   - kill(signal) is a hard termination the child cannot intercept;
//   - memory limits via --max-old-space-size RLIMIT.
//
// This file is plain JS — fork() requires a real file on disk.
import { parentPort } from 'node:worker_threads'; // NOT used — fork uses process.send

// Extract workerData-equivalent from process.argv (fork passes args)
const payloadJson = process.argv[process.argv.length - 1];
if (!payloadJson || !payloadJson.startsWith('{')) {
  process.send?.({ error: 'executor: no payload' });
  process.exit(1);
}

const data = JSON.parse(payloadJson);
const { pathToFileURL } = await import('node:url');

function post(message) {
  process.send?.(message);
}

async function storageOp(op, args) {
  const res = await fetch(data.storageEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
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
    state: { save: async () => undefined },
    cache: { get: async () => undefined, set: async () => undefined },
    pubsub: { publish: async () => undefined, subscribe: async () => undefined },
    timer: { start: async () => undefined, stop: async () => undefined },
    votes: { create: async () => undefined },
    scores: { add: async () => undefined },
    voice: { getParticipants: () => env.voiceParticipants },
    storage: {
      get: async (key) => (await storageOp('get', { key, serverId: env.serverId, pluginId: env.pluginId })).value,
      set: async (key, value) => void (await storageOp('set', { key, value, serverId: env.serverId, pluginId: env.pluginId })),
      delete: async (key) => (await storageOp('delete', { key, serverId: env.serverId, pluginId: env.pluginId })).deleted,
      list: async () => (await storageOp('list', { serverId: env.serverId, pluginId: env.pluginId })).items,
      clear: async () => void (await storageOp('clear', { serverId: env.serverId, pluginId: env.pluginId })),
    },
  };
}

void (async () => {
  try {
    const mod = await import(pathToFileURL(data.pluginPath).href);
    const raw = mod?.plugin ?? mod?.default;
    if (!raw || typeof raw !== 'object') {
      post({ error: 'plugin bundle has no export' });
      return;
    }
    const plugin = raw;

    let result;
    if (data.op === 'describe') {
      result = { id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version ?? null };
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
