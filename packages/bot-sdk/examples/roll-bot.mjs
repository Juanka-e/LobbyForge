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
 */
import { LobbyForgeBot } from '../dist/index.js';

const baseUrl = process.env.LOBBYFORGE_URL;
const token = process.env.LOBBYFORGE_BOT_TOKEN;
if (!baseUrl || !token) {
  console.error('Set LOBBYFORGE_URL and LOBBYFORGE_BOT_TOKEN.');
  process.exit(1);
}

const bot = new LobbyForgeBot({ baseUrl, token });

/** A fair die roll (1..sides) from the platform's CSPRNG. */
function roll(sides) {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return 1 + (buf[0] % sides);
}

// Registering is a bulk overwrite: this list IS the bot's command set.
await bot.commands.set([
  {
    name: 'roll',
    description: 'Roll a die',
    options: [
      { name: 'sides', description: 'How many sides (default 6)', type: 'integer', min: 2, max: 1000 },
      { name: 'private', description: 'Only you see the result', type: 'boolean' },
    ],
  },
]);

bot.on('ready', ({ bot: me, channels }) => {
  console.info(`${me.name} is listening in ${channels.length} channel(s): ${channels.map((c) => `#${c.name}`).join(', ')}`);
});

bot.on('interaction', async (interaction) => {
  if (interaction.commandName !== 'roll') return;
  const sides = typeof interaction.options.sides === 'number' ? interaction.options.sides : 6;
  const who = interaction.user.displayName ?? 'Someone';
  // Answer within 15 minutes; ephemeral answers reach only the invoker.
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
  console.warn(`Event stream closed (${code}${reason ? ` ${reason}` : ''})${willReconnect ? `; reconnecting in ${delayMs} ms` : ''}`);
});

bot.on('error', (error) => {
  console.error(error);
});

try {
  await bot.connect();
} catch (error) {
  // 4001 bad token, 4003 disabled / missing receive_events, 4009 replaced.
  console.error(`Could not connect: ${error.message}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bot.close();
    process.exit(0);
  });
}
