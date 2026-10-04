/**
 * Which channels a bot reaches (docs/BOT_API_V2.md §1.1) — the ONE helper
 * every bot-reachable path uses: the v1 and v2 Bot API routes, the built-in
 * bots (through `postBotMessage`), command checks, interaction answers and
 * event fan-out. The rule itself lives in `@lobbyforge/db`
 * (`queries/botChannelAccess.ts`) so the WebSocket gateway reads exactly
 * the same thing, by the bot's stored mode (`bots.channel_access_mode`):
 *
 *   - `all` → every text / announcement channel of the bot's server
 *     without a role gate (the v1 behaviour, unchanged);
 *   - `selected` → exactly its `bot_channel_access` rows (still text /
 *     announcement channels of the bot's own server) — and NO channel when
 *     it has none left. "No rows" never means "all".
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getBotChannelAccessState,
  getBotReachableChannel,
  listBotAccessibleChannels,
  listBotReachableChannels,
  listChannelsForServer,
  listVisibleChannelsForMember,
  type BotChannelAccessMode,
  type ChannelRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export interface BotAccessSubject {
  id: string;
  serverId: string;
}

/** The channel if this bot may use it, else null (the caller answers 404). */
export async function botCanAccessChannel(bot: BotAccessSubject, channelId: string): Promise<ChannelRow | null> {
  return getBotReachableChannel(getDb(), { id: bot.id, serverId: bot.serverId }, channelId);
}

/** Every channel this bot reaches, in channel-list order. */
export async function listBotChannels(bot: BotAccessSubject): Promise<ChannelRow[]> {
  return listBotReachableChannels(getDb(), { id: bot.id, serverId: bot.serverId });
}

/** Only the literal `'all'` uses the v1 rule; anything else (unknown, missing) is `selected`. */
export function isAllChannelsMode(mode: unknown): mode is 'all' {
  return mode === 'all';
}

/**
 * The same decision for many channels at once, from data the caller already
 * holds (event fan-out, the composer list) — no query per bot.
 *
 * `mode`: the bot's stored §1.1 mode (from its row). `granted`: its grant
 * rows — in `selected` mode exactly the channels it reaches, so [] = none.
 * `openToBots`: whether the channel has no role gate (read only in `all`
 * mode). The channel must already be known to be a text / announcement
 * channel of the bot's server.
 */
export function botReachesChannel(input: {
  mode: BotChannelAccessMode | string | undefined;
  granted: readonly string[];
  channelId: string;
  openToBots: boolean;
}): boolean {
  if (isAllChannelsMode(input.mode)) return input.openToBots;
  return input.granted.includes(input.channelId);
}

// ── the managers' view (Admin → Bots → channel access) ──────────────────

const BOT_CHANNEL_TYPES: ReadonlySet<string> = new Set(['text', 'announcement']);

export interface ChannelAccessManager {
  uid: string;
  isOwner: boolean;
  permissions: readonly string[];
}

export interface ChannelAccessView {
  /** `all`: every channel without a role gate; `selected`: exactly the granted ones (none = no channel). */
  mode: BotChannelAccessMode;
  channels: Array<{
    id: string;
    name: string;
    type: string;
    position: number;
    /** Has a role gate (a private channel). */
    gated: boolean;
    /** Explicitly granted. */
    granted: boolean;
    /** The bot reaches it right now. */
    reachable: boolean;
    /** This manager may grant it (a role-gated channel needs Manage Channels). */
    grantable: boolean;
  }>;
  /** Grants on role-gated channels this manager cannot see (named nowhere). */
  hiddenGrantCount: number;
  /** Internal: the hidden grants, kept untouched on a bulk replace. */
  hiddenGrantIds: string[];
  /** Internal: every eligible channel id with its gate, for validation. */
  eligible: Map<string, { gated: boolean; visible: boolean }>;
}

/**
 * Granting a role-gated channel needs MANAGE_CHANNELS (§1.1) — which also
 * means the manager sees every channel (`authorizeChannelVisibility`
 * passes MANAGE_CHANNELS holders through). Owner and administrators hold it.
 */
export function canGrantGatedChannels(manager: ChannelAccessManager): boolean {
  return manager.isOwner || hasPermission([...manager.permissions], CorePermission.MANAGE_CHANNELS);
}

/**
 * What a bot manager sees of a bot's channel access: every text /
 * announcement channel of the server THEY can see, with its state. A
 * role-gated channel the manager cannot see is never named — a grant on
 * one is only counted, and a bulk replace keeps it as it is.
 */
export async function loadChannelAccessView(
  bot: BotAccessSubject,
  manager: ChannelAccessManager
): Promise<ChannelAccessView> {
  const [all, open, access] = await Promise.all([
    listChannelsForServer(getDb(), bot.serverId, { limit: 500 }),
    listBotAccessibleChannels(getDb(), bot.serverId),
    getBotChannelAccessState(getDb(), bot.id),
  ]);
  const selectedMode = access.mode === 'selected';
  const openIds = new Set(open.map((c) => c.id));
  const seesAll = canGrantGatedChannels(manager);
  const visibleIds = seesAll
    ? null
    : new Set((await listVisibleChannelsForMember(getDb(), bot.serverId, manager.uid)).map((c) => c.id));
  // Grant rows only count in selected mode (switching to `all` deletes them).
  const grantedIds = new Set(selectedMode ? access.channelIds : []);
  const eligible = new Map<string, { gated: boolean; visible: boolean }>();
  const channels: ChannelAccessView['channels'] = [];
  const hidden: string[] = [];
  for (const channel of all) {
    if (!BOT_CHANNEL_TYPES.has(channel.type)) continue;
    const gated = !openIds.has(channel.id);
    const visible = visibleIds === null || visibleIds.has(channel.id);
    eligible.set(channel.id, { gated, visible });
    if (!visible) {
      if (grantedIds.has(channel.id)) hidden.push(channel.id);
      continue;
    }
    const isGranted = grantedIds.has(channel.id);
    channels.push({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      position: channel.position,
      gated,
      granted: isGranted,
      reachable: selectedMode ? isGranted : !gated,
      grantable: !gated || seesAll,
    });
  }
  return {
    mode: access.mode,
    channels,
    hiddenGrantCount: hidden.length,
    hiddenGrantIds: hidden,
    eligible,
  };
}

/** The view without its internal fields, for a response body. */
export function channelAccessJson(view: ChannelAccessView) {
  return { mode: view.mode, channels: view.channels, hiddenGrantCount: view.hiddenGrantCount };
}
