/**
 * App messages: what a plugin's `chat.post` effect writes (docs/PLUGIN_SDK.md
 * "Effects", docs/PLUGIN_UNLOCK_PLAN.md phase 3).
 *
 * WHERE: an activity runs in a voice or stage channel, and those have no
 * text chat in the lobby (a message stored under a voice channel would be
 * shown nowhere). So an app posts to the text or announcement channel the
 * community chose for it in Server settings → Apps ("App messages go to",
 * `settings.chatChannelId` of the app's install). With no channel chosen —
 * the default, so a game never writes into a channel nobody picked, which
 * could also leak a private voice room's game into a public channel — the
 * post is dropped. The channel is re-checked on every post: it must still
 * belong to the community and still be a text or announcement channel.
 *
 * WHAT: a message with no author (no user, no bot), `metadata.app =
 * { pluginId, name }` — clients show it with the App badge. The text was
 * validated by the SDK (1–500 characters, no control characters); here
 * every `@` that could start a mention gets a zero-width space after it,
 * so it pings nobody: not `@everyone`, not `@here`, not a member by name
 * (the lobby treats `@<display name>` in the text as a mention).
 *
 * HOW OFTEN: at most one per 5 s and 30 per hour per session, and at most
 * 60 per hour per (community, plugin) — the session limits alone reset
 * whenever the activity is restarted. Over a limit the post is dropped
 * (logged) — chat is a side channel; the action that asked for it still
 * applies.
 *
 * MODERATION: a post goes through the community's Moderation Bot like a
 * member's message or a webhook's post — its blocked-word and link rules
 * (lib/bots/moderation.ts `moderateAppMessage`). A post the rules block is
 * dropped (logged and audited as `bot.moderation.block`); the action still
 * applies. The limits run first, so a plugin cannot turn blocked posts
 * into an audit-log flood.
 *
 * Delivered like every other message: stored, published on the chat bus,
 * and audited as `message.create` (actor: none; the plugin named in the
 * metadata).
 */
import {
  createAppMessage,
  getChannelById,
  getPluginInstall,
  logAction,
  type DbClient,
} from '@lobbyforge/db';
import { publishChatMessage } from './chat-bus';
import { distributedRateLimit, type RateLimitConfig } from './security-headers';
import { moderateAppMessage } from './bots/moderation';

/** Channel types an app may post to (they have a chat in the lobby). */
export const APP_MESSAGE_CHANNEL_TYPES = new Set(['text', 'announcement']);

export const APP_CHAT_BURST_LIMIT: RateLimitConfig = { windowMs: 5_000, maxRequests: 1 };
export const APP_CHAT_HOURLY_LIMIT: RateLimitConfig = { windowMs: 60 * 60 * 1000, maxRequests: 30 };
/** Per community and plugin, across its sessions: restarting the activity does not reset it. */
export const APP_CHAT_PLUGIN_HOURLY_LIMIT: RateLimitConfig = { windowMs: 60 * 60 * 1000, maxRequests: 60 };

const ZERO_WIDTH_SPACE = '​';

/**
 * Make every mention inert: an `@` directly followed by a non-space gets a
 * zero-width space after it. It reads the same, and neither the mass
 * mention rule (`@everyone` / `@here`) nor the lobby's `@name` match
 * applies to it.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/[@＠﹫](?=\S)/g, (at) => `${at}${ZERO_WIDTH_SPACE}`);
}

/** The channel the community chose for this app's messages, if it is still one an app may post to. */
async function appChatChannel(db: DbClient, serverId: string, pluginId: string): Promise<string | null> {
  const install = await getPluginInstall(db, serverId, pluginId);
  if (!install || !install.enabled) return null;
  const settings = install.settings && typeof install.settings === 'object' ? (install.settings as Record<string, unknown>) : {};
  const channelId = settings.chatChannelId;
  if (typeof channelId !== 'string' || channelId.length === 0) return null;
  const channel = await getChannelById(db, channelId);
  if (!channel || channel.serverId !== serverId || !APP_MESSAGE_CHANNEL_TYPES.has(channel.type)) return null;
  return channel.id;
}

export type AppMessageOutcome =
  | { posted: true; messageId: string; channelId: string }
  | { posted: false; reason: 'no_channel' | 'rate_limited' | 'blocked_by_moderation' };

/**
 * Post one app message for a session. `text` is already validated by the
 * SDK (`chat.post`). Never throws for an ordinary refusal; a database
 * failure throws (the caller logs it).
 */
export async function postAppMessage(input: {
  db: DbClient;
  serverId: string;
  sessionId: string;
  pluginId: string;
  pluginName: string;
  text: string;
}): Promise<AppMessageOutcome> {
  const channelId = await appChatChannel(input.db, input.serverId, input.pluginId);
  if (!channelId) return { posted: false, reason: 'no_channel' };

  // The burst limit first, so a refused burst does not use up the hour.
  const burst = await distributedRateLimit(`activity-app-chat:burst:${input.sessionId}`, APP_CHAT_BURST_LIMIT);
  if (!burst.allowed) return { posted: false, reason: 'rate_limited' };
  const hourly = await distributedRateLimit(`activity-app-chat:hour:${input.sessionId}`, APP_CHAT_HOURLY_LIMIT);
  if (!hourly.allowed) return { posted: false, reason: 'rate_limited' };
  const perPlugin = await distributedRateLimit(
    `activity-app-chat:plugin-hour:${input.serverId}:${input.pluginId}`,
    APP_CHAT_PLUGIN_HOURLY_LIMIT
  );
  if (!perPlugin.allowed) return { posted: false, reason: 'rate_limited' };

  // The community's word and link rules, on the text as the plugin wrote it.
  const verdict = await moderateAppMessage({
    serverId: input.serverId,
    channelId,
    pluginId: input.pluginId,
    pluginName: input.pluginName,
    sessionId: input.sessionId,
    content: input.text,
  });
  if (verdict.action === 'block') return { posted: false, reason: 'blocked_by_moderation' };

  const content = neutralizeMentions(input.text);
  const app = { pluginId: input.pluginId, name: input.pluginName.slice(0, 80) };
  const created = await createAppMessage(input.db, { channelId, content, metadata: { app } });
  publishChatMessage({
    serverId: input.serverId,
    channelId,
    message: {
      id: created.id,
      channelId: created.channelId,
      userId: null,
      botId: null,
      bot: null,
      content: created.content,
      metadata: created.metadata,
      replyToId: null,
      createdAt: created.createdAt.toISOString(),
    },
  });
  void logAction(input.db, {
    serverId: input.serverId,
    actorUserId: null,
    action: 'message.create',
    targetType: 'message',
    targetId: created.id,
    metadata: { channelId, pluginId: input.pluginId, sessionId: input.sessionId, app: true },
  }).catch((err) => console.error('[audit] app message.create failed:', (err as Error).message));
  return { posted: true, messageId: created.id, channelId };
}
