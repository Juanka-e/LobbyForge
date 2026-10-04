#!/usr/bin/env node
/**
 * /roll over HTTPS — a bot with no socket at all.
 *
 * The instance POSTs every event the bot subscribed to (§5.2), signed with
 * the endpoint secret. Interactions may be answered synchronously: a 200
 * with `{ "type": "respond", "content": "…", "ephemeral": false }` within
 * 3 seconds counts as the answer.
 *
 *   pnpm --filter @lobbyforge/bot-sdk build
 *   LOBBYFORGE_ENDPOINT_SECRET=whsec_… PORT=8787 node packages/bot-sdk/examples/http-bot.mjs
 *
 * Put it behind HTTPS (a reverse proxy or tunnel — the instance only calls
 * public https URLs), then register the URL once (needs receive_events;
 * the secret is returned ONCE):
 *
 *   const bot = new LobbyForgeBot({ baseUrl, token });
 *   const { secret } = await bot.eventEndpoint.set('https://bot.example.com/lobbyforge', {
 *     events: ['interaction_create'],
 *   });
 *   await bot.commands.set([{ name: 'roll', description: 'Roll a die',
 *     options: [{ name: 'sides', description: 'Sides', type: 'integer', min: 2, max: 1000 }] }]);
 */
import { createServer } from 'node:http';
import { verifySignature } from '../dist/index.js';

const secret = process.env.LOBBYFORGE_ENDPOINT_SECRET;
const port = Number(process.env.PORT || 8787);
if (!secret) {
  console.error('Set LOBBYFORGE_ENDPOINT_SECRET (returned once when the endpoint was set).');
  process.exit(1);
}

const MAX_BODY_BYTES = 64 * 1024;

function roll(sides) {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return 1 + (buf[0] % sides);
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** Decide what to answer for one verified delivery. */
function handle(delivery) {
  if (delivery.event !== 'interaction_create') {
    console.info(`event ${delivery.event}`, delivery.data);
    return undefined; // 204: acknowledged
  }
  const { interaction } = delivery.data;
  if (interaction.commandName !== 'roll') return undefined;
  const sides = typeof interaction.options.sides === 'number' ? interaction.options.sides : 6;
  return {
    type: 'respond',
    content: `${interaction.user.displayName ?? 'Someone'} rolled ${roll(sides)} (d${sides})`,
    ephemeral: false,
  };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    send(res, 405);
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      send(res, 413);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    // Verify the RAW bytes — re-serialized JSON would not match.
    const raw = Buffer.concat(chunks);
    const ok = verifySignature({
      secret,
      timestamp: req.headers['x-lobbyforge-timestamp'],
      signature: req.headers['x-lobbyforge-signature'],
      body: raw,
    });
    if (!ok) {
      send(res, 401, { error: 'bad signature' });
      return;
    }
    let delivery;
    try {
      delivery = JSON.parse(raw.toString('utf8'));
    } catch {
      send(res, 400, { error: 'bad json' });
      return;
    }
    // Retries resend the same delivery id; answering twice is harmless here
    // (the instance accepts one answer per interaction).
    const answer = handle(delivery);
    if (answer) send(res, 200, answer);
    else send(res, 204);
  });
});

server.listen(port, () => {
  console.info(`LobbyForge HTTP bot listening on :${port}`);
});
