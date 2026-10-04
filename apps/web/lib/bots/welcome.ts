/**
 * The Welcome Bot — greets a member when they join the server.
 *
 * Called by every path that creates a membership (invite redemption,
 * registration, the lobby's auto-join on open instances) AFTER the join
 * committed. It never throws: a greeting that fails must not fail a join.
 *
 * The greeting goes through `postBotMessage`, so the bot needs
 * `send_messages`, an open text channel of its own server, and cannot
 * ping @everyone. A raid (many joins at once) is capped at
 * WELCOME_RATE greetings per server; joins beyond it simply go unwelcomed.
 */
import { getServerById, getUserById } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { distributedRateLimit, type RateLimitConfig } from '@/lib/security-headers';
import { getBuiltInBot } from './cache';
import { listBotChannels } from './access';
import { emitMemberEvent } from './events';
import { postBotMessage } from './messages';
import { parseWelcomeSettings } from './settings';
import { defaultBotText, renderBotTemplate } from './templates';

export const WELCOME_RATE: RateLimitConfig = { windowMs: 60_000, maxRequests: 10 };

export async function notifyMemberJoined(input: { serverId: string; userId: string }): Promise<void> {
  // Bot API v2: every join path already calls this hook, so it is also
  // where bots with `read_members` hear about the newcomer (fire-and-forget,
  // whether or not a Welcome Bot exists).
  emitMemberEvent({ serverId: input.serverId, userId: input.userId, event: 'member_join' });
  try {
    const bot = await getBuiltInBot(input.serverId, 'welcome');
    if (!bot || !bot.enabled) return;

    const gate = await distributedRateLimit(`bot-welcome:${input.serverId}`, WELCOME_RATE);
    if (!gate.allowed) {
      console.warn(`[bots] welcome skipped for server ${input.serverId}: too many joins at once`);
      return;
    }

    const settings = parseWelcomeSettings(bot.settings);
    const channelId = settings.channelId ?? (await listBotChannels(bot))[0]?.id ?? null;
    if (!channelId) return;

    const [member, server] = await Promise.all([
      getUserById(getDb(), input.userId),
      getServerById(getDb(), input.serverId),
    ]);
    if (!member || !server) return;

    const template = settings.template ?? defaultBotText('bots.welcome.defaultTemplate');
    const content = renderBotTemplate(template, { user: member.displayName, server: server.name });
    if (!content) return;

    const posted = await postBotMessage({ bot, channelId, content });
    if (!posted.ok) console.warn(`[bots] welcome not posted in ${channelId}: ${posted.code}`);
  } catch (err) {
    console.error('[bots] welcome failed:', (err as Error).message);
  }
}
