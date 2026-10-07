#!/usr/bin/env node
/**
 * /roll over the event stream — a complete LobbyForge bot.
 *
 *   pnpm --filter @lobbyforge/bot-sdk build
 *   LOBBYFORGE_URL=https://chat.example.com LOBBYFORGE_BOT_TOKEN=lfb_… \
 *     node packages/bot-sdk/examples/roll-bot.mjs
 *
 * Give the bot: receive_events (the stream), slash_commands (register and
 * answer /roll), send_messages (public answers) and read_messages (to see
 * "!roll" typed in chat). Node ≥ 22 has a global WebSocket; on older
 * runtimes pass one: `new LobbyForgeBot({ …, WebSocket })` from the `ws`
 * package. In a standalone project import from '@lobbyforge/bot-sdk'.
 *
 * Exit codes: 0 after Ctrl+C / SIGTERM, 1 on anything fatal — a refused
 * start (bad token, a command name another bot owns, missing permission,
 * instance unreachable) or a stream the gateway closed for good (token
 * rotated or revoked, bot disabled, another copy of the bot took over).
 * A supervisor (systemd, Docker, pm2) can tell "stopped" from "broken".
 */
import { BotApiError, BotCloseCode, LobbyForgeBot } from '../dist/index.js';

const baseUrl = process.env.LOBBYFORGE_URL;
const token = process.env.LOBBYFORGE_BOT_TOKEN;
if (!baseUrl || !token) {
  console.error('Set LOBBYFORGE_URL and LOBBYFORGE_BOT_TOKEN.');
  process.exit(1);
}

const COMMAND = 'roll';

/** One line a person can act on, for an error from the Bot API or the stream. */
function explain(error) {
  if (!(error instanceof BotApiError)) return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case 'command_name_taken': {
      const names = Array.isArray(error.details.names) ? error.details.names : [COMMAND];
      return `${names.map((name) => `/${name}`).join(', ')} ${names.length === 1 ? 'is' : 'are'} already registered by another bot on this server — pick another name.`;
    }
    case 'unauthorized':
      return 'The token was rejected (wrong, revoked or rotated). Create a new token in Server settings → Bots.';
    case 'missing_permission':
      return `The bot lacks the "${error.details.permission ?? error.permission ?? 'required'}" permission. Grant it in Server settings → Bots.`;
    case 'bot_disabled':
      return 'The bot is disabled. Enable it in Server settings → Bots.';
    case 'replaced':
      return 'Another connection for this bot took over the event stream — is a second copy of this bot running?';
    case 'rate_limited':
      return `Rate limited by the instance; try again in ${error.retryAfter ?? 'a few'} seconds.`;
    case 'network_error':
    case 'timeout':
      return `Could not reach ${baseUrl}: ${error.message}`;
    default:
      return `${error.message}${error.status ? ` (HTTP ${error.status}, ${error.code})` : ` (${error.code})`}`;
  }
}

/** Why the gateway closed the stream for good (it will not reconnect after these). */
function explainClose(code, reason) {
  if (code === BotCloseCode.UNAUTHORIZED) return 'The token was revoked or rotated (4001). Create a new token and restart the bot.';
  if (code === BotCloseCode.FORBIDDEN) return 'The bot was disabled or lost "receive_events" (4003). Fix it in Server settings → Bots and restart.';
  if (code === BotCloseCode.REPLACED) return 'Another connection for this bot took over (4009) — is a second copy of this bot running? This one stops.';
  return `The event stream closed (${code}${reason ? ` ${reason}` : ''}) and will not reconnect.`;
}

function fatal(message) {
  console.error(message);
  process.exit(1);
}

const bot = new LobbyForgeBot({ baseUrl, token });
let stopping = false;

/** A fair die roll (1..sides) from the platform's CSPRNG. */
function roll(sides) {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return 1 + (buf[0] % sides);
}

// Registering is a bulk overwrite: this list IS the bot's command set.
try {
  await bot.commands.set([
    {
      name: COMMAND,
      description: 'Roll a die',
      options: [
        { name: 'sides', description: 'How many sides (default 6)', type: 'integer', min: 2, max: 1000 },
        { name: 'private', description: 'Only you see the result', type: 'boolean' },
      ],
    },
  ]);
} catch (error) {
  fatal(`Could not register /${COMMAND}: ${explain(error)}`);
}

bot.on('ready', ({ bot: me, channels }) => {
  console.info(`${me.name} is listening in ${channels.length} channel(s): ${channels.map((c) => `#${c.name}`).join(', ')}`);
});

bot.on('interaction', async (interaction) => {
  if (interaction.commandName !== COMMAND) return;
  const sides = typeof interaction.options.sides === 'number' ? interaction.options.sides : 6;
  const who = interaction.user.displayName ?? 'Someone';
  // Answer within 15 minutes; ephemeral answers reach only the invoker.
  // A failed answer (expired, already answered, a missing permission)
  // reaches the 'error' listener below; the bot keeps running.
  await interaction.reply(`${who} rolled ${roll(sides)} (d${sides})`, {
    ephemeral: interaction.options.private === true,
  });
});

// Plain chat works too (needs read_messages + send_messages).
bot.on('message', async (message) => {
  if (message.author.bot || message.content.trim() !== '!roll') return;
  await bot.sendMessage(message.channelId, `${message.author.displayName ?? 'Someone'} rolled ${roll(6)} (d6)`);
});

bot.on('channel_access_changed', (channels) => {
  console.info(`Now in ${channels.length} channel(s).`);
});

bot.on('disconnect', ({ code, reason, willReconnect, delayMs }) => {
  if (willReconnect) {
    console.warn(`Event stream closed (${code}${reason ? ` ${reason}` : ''}); reconnecting in ${delayMs} ms`);
    return;
  }
  // Ctrl+C / SIGTERM: a clean stop.
  if (stopping) return;
  // The gateway will not take this bot back without a fix: say why, exit 1.
  fatal(explainClose(code, reason));
});

bot.on('error', (error) => {
  // A failed answer or send, a listener that threw: report it, keep going.
  console.error(`Error: ${explain(error)}`);
});

try {
  await bot.connect();
} catch (error) {
  // 4001 bad token, 4003 disabled / missing receive_events, 4009 replaced.
  fatal(`Could not connect: ${explain(error)}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    bot.close();
    process.exit(0);
  });
}
