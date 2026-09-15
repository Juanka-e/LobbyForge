// Plugin executor — CHILD PROCESS variant (16th-audit).
//
// Runs ONE plugin op in a dedicated child process. The payload arrives
// via the fork IPC channel (process.on('message')), NOT argv —
// /proc/<pid>/cmdline would otherwise expose sibling plugins' state,
// actions and scoped capabilities to any same-UID process.
//
// This file is plain JS — fork() requires a real file on disk.
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

// 16th-audit: receive the payload via the IPC channel (private to the
// parent-child pair) — argv is readable by every same-UID process via
// /proc/<pid>/cmdline and capped at ~128 KiB per string.
let data = null;
process.on('message', async (payload) => {
  data = payload;
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
});
