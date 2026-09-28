/**
 * What a bot can do with channels and messages — one implementation for
 * the Bot API and the built-in bots, so both obey the same rules:
 *
 *   - the bot must be enabled and hold the permission for the action;
 *   - the channel must belong to the BOT'S server (a bot never reaches
 *     another server — a foreign channel id is simply "not found");
 *   - only text / announcement channels without a role gate — a bot has
 *     no roles, so a private channel stays private;
 *   - no `@everyone` / `@here` — a bot cannot ping the whole server.
 *
 * A bot message is stored like a member's (same table, same realtime
 * fan-out, same audit entry) with `user_id` NULL, `bot_id` set and a
 * `metadata.bot` snapshot, which is how every client shows the BOT badge.
 */
import {
  BOT_MESSAGE_CHANNEL_TYPES,
  createMessage,
  getChannelById,
  isChannelOpenToBots,
  listBotAccessibleChannels,
  listMessagesForChannel,
  listUserDisplayNames,
  logAction,
  type ChannelRow,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { publishChatMessage } from '@/lib/chat-bus';
import { MAX_BOT_MESSAGE_LENGTH, type BotPermissionId } from './catalog';
import { botHasPermission } from './permissions';
import { containsMassMention } from './settings';
import { readMessageBot } from './message-meta';
import { noteBotActivity } from './activity';

/** The part of a bot row the actions need. */
export interface BotActor {
  id: string;
  serverId: string;
  name: string;
  type: string;
  enabled: boolean;
  permissions: readonly string[];
}

export interface BotFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  extra?: Record<string, unknown>;
}

export type BotResult<T> = { ok: true; value: T } | BotFailure;

function fail(status: number, code: string, error: string, extra?: Record<string, unknown>): BotFailure {
  return { ok: false, status, code, error, ...(extra ? { extra } : {}) };
}

function requirePermission(bot: BotActor, permission: BotPermissionId): BotFailure | null {
  if (!bot.enabled) return fail(403, 'bot_disabled', 'This bot is disabled');
  if (!botHasPermission(bot, permission)) {
    return fail(403, 'missing_permission', `This bot lacks the ${permission} permission`, { permission });
  }
  return null;
}

const CHANNEL_UNAVAILABLE = 'Channel not found, or not available to bots';

/** The channel, if it is one this bot may use. */
export async function resolveBotChannel(bot: BotActor, channelId: string): Promise<BotResult<ChannelRow>> {
  const channel = await getChannelById(getDb(), channelId);
  if (
    !channel ||
    channel.serverId !== bot.serverId ||
    !(BOT_MESSAGE_CHANNEL_TYPES as readonly string[]).includes(channel.type)
  ) {
    return fail(404, 'not_found', CHANNEL_UNAVAILABLE);
  }
  if (!(await isChannelOpenToBots(getDb(), channel.id))) return fail(404, 'not_found', CHANNEL_UNAVAILABLE);
  return { ok: true, value: channel };
}

export interface BotApiChannel {
  id: string;
  name: string;
  type: string;
  position: number;
  topic: string | null;
}

export async function listChannelsForBot(bot: BotActor): Promise<BotResult<BotApiChannel[]>> {
  if (!bot.enabled) return fail(403, 'bot_disabled', 'This bot is disabled');
  if (!botHasPermission(bot, 'read_messages') && !botHasPermission(bot, 'send_messages')) {
    return fail(403, 'missing_permission', 'This bot needs read_messages or send_messages to see channels', {
      permission: 'read_messages',
    });
  }
  const channels = await listBotAccessibleChannels(getDb(), bot.serverId);
  return {
    ok: true,
    value: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, position: c.position, topic: c.topic })),
  };
}

export type BotApiMessageAuthor =
  | { type: 'user'; id: string; name: string | null }
  | { type: 'bot'; id: string | null; name: string }
  | { type: 'unknown'; id: null; name: null };

export interface BotApiMessage {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: string | null;
  author: BotApiMessageAuthor;
}

export function toBotApiMessage(row: MessageRow, names: ReadonlyMap<string, string>): BotApiMessage {
  const bot = readMessageBot(row);
  const author: BotApiMessageAuthor = bot
    ? { type: 'bot', id: bot.id, name: bot.name }
    : row.userId
      ? { type: 'user', id: row.userId, name: names.get(row.userId) ?? null }
      : { type: 'unknown', id: null, name: null };
  return {
    id: row.id,
    channelId: row.channelId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    replyToId: row.replyToId,
    author,
  };
}

export async function readMessagesForBot(
  bot: BotActor,
  channelId: string,
  options: { limit: number; before?: Date }
): Promise<BotResult<BotApiMessage[]>> {
  const denied = requirePermission(bot, 'read_messages');
  if (denied) return denied;
  const channel = await resolveBotChannel(bot, channelId);
  if (!channel.ok) return channel;
  const rows = await listMessagesForChannel(getDb(), channel.value.id, {
    limit: options.limit,
    ...(options.before ? { before: options.before } : {}),
  });
  const names = await listUserDisplayNames(
    getDb(),
    rows.map((row) => row.userId).filter((id): id is string => Boolean(id))
  );
  return { ok: true, value: rows.map((row) => toBotApiMessage(row, names)) };
}

/**
 * Post a message as a bot. Returns the stored row; publishes it to the
 * realtime bus and writes the same `message.create` audit entry a member
 * message gets (actor: the bot, recorded in metadata).
 */
export async function postBotMessage(input: {
  bot: BotActor;
  channelId: string;
  content: string;
}): Promise<BotResult<MessageRow>> {
  const { bot } = input;
  const denied = requirePermission(bot, 'send_messages');
  if (denied) return denied;
  const content = input.content.trim();
  if (!content || content.length > MAX_BOT_MESSAGE_LENGTH) {
    return fail(400, 'invalid_request', `content must be 1–${MAX_BOT_MESSAGE_LENGTH} characters`);
  }
  if (containsMassMention(content)) {
    return fail(403, 'mass_mention_forbidden', 'Bots cannot mention @everyone or @here');
  }
  const channel = await resolveBotChannel(bot, input.channelId);
  if (!channel.ok) return channel;

  const snapshot = { id: bot.id, name: bot.name, type: bot.type };
  const created = await createMessage(getDb(), {
    channelId: channel.value.id,
    userId: null,
    botId: bot.id,
    content,
    metadata: { bot: snapshot },
  });
  publishChatMessage({
    serverId: bot.serverId,
    channelId: created.channelId,
    message: {
      id: created.id,
      channelId: created.channelId,
      userId: null,
      botId: bot.id,
      bot: snapshot,
      content: created.content,
      metadata: created.metadata,
      replyToId: created.replyToId,
      createdAt: created.createdAt.toISOString(),
    },
  });
  void logAction(getDb(), {
    serverId: bot.serverId,
    actorUserId: null,
    action: 'message.create',
    targetType: 'message',
    targetId: created.id,
    metadata: { channelId: created.channelId, botId: bot.id, botName: bot.name, botType: bot.type },
  }).catch((err) => console.error('[audit] bot message.create failed:', (err as Error).message));
  noteBotActivity(bot.id);
  return { ok: true, value: created };
}
