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
 *
 * `commands.set` rejects with a BotApiError whose `code` says why — e.g.
 * `command_name_taken` (with `details.names`) when another bot of the
 * server already owns /roll: catch it and pick another name.
 *
 * Exit codes: 0 after Ctrl+C / SIGTERM, 1 when it cannot run (no secret, a
 * bad PORT, the port already in use).
 */
import { createServer } from 'node:http';
import { verifySignature } from '../dist/index.js';

const secret = process.env.LOBBYFORGE_ENDPOINT_SECRET;
const port = Number(process.env.PORT || 8787);
if (!secret) {
  console.error('Set LOBBYFORGE_ENDPOINT_SECRET (returned once when the endpoint was set).');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a port number from 1 to 65535 (got "${process.env.PORT}").`);
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
    // JSON keeps whatever the payload holds on one line.
    console.info('event %s', JSON.stringify({ event: delivery.event, data: delivery.data }));
    return undefined; // 204: acknowledged
  }
  const interaction = delivery.data?.interaction;
  if (!interaction || interaction.commandName !== 'roll') return undefined;
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
    let answer;
    try {
      answer = handle(delivery);
    } catch (error) {
      // A payload this bot does not understand must not take the process down.
      // JSON keeps whatever the payload holds on one line.
      console.error(
        'Could not handle a delivery: %s',
        JSON.stringify({ event: String(delivery?.event), error: error instanceof Error ? error.message : String(error) })
      );
      send(res, 500, { error: 'handler failed' });
      return;
    }
    if (answer) send(res, 200, answer);
    else send(res, 204);
  });
});

server.on('error', (error) => {
  // EADDRINUSE / EACCES: say so in one line, not a stack trace.
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use — stop the other process or set PORT.`);
  else if (error.code === 'EACCES') console.error(`Not allowed to listen on port ${port} — pick a port above 1024 or run with the needed rights.`);
  else console.error(`The HTTP server failed: ${error.message}`);
  process.exit(1);
});

server.listen(port, () => {
  console.info(`LobbyForge HTTP bot listening on :${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
