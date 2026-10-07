/**
 * Browser calls for Bot API v2 (docs/BOT_API_V2.md): the composer's slash
 * commands (§3.3), ephemeral answers on the `user:{uid}` topic (§3.4,
 * §4.3), and the admin routes for bot channel access, bot commands, the
 * bot event endpoint and channel webhooks.
 *
 * Every path and every response shape the UI relies on is in this one
 * module, parsed defensively, so the pages never read a raw payload and a
 * route change is a change here only. Results carry the machine `code`;
 * the UI turns it into a sentence in the reader's language.
 */
import { SHARED_REFUSAL_KEYS } from '../activity-refusal';
import { INTERACTION_TTL_MS } from './catalog';
import { parseChannelCommand, type ChannelCommand, type CommandOption, parseCommandOption } from './command-options';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const seg = encodeURIComponent;

export const botV2Paths = {
  channelCommands: (serverId: string, channelId: string) =>
    `/api/servers/${seg(serverId)}/commands?channelId=${seg(channelId)}`,
  invoke: (serverId: string, channelId: string, commandId: string) =>
    `/api/servers/${seg(serverId)}/channels/${seg(channelId)}/commands/${seg(commandId)}/invoke`,
  botChannelAccess: (serverId: string, botId: string) =>
    `/api/servers/${seg(serverId)}/bots/${seg(botId)}/channel-access`,
  botCommands: (serverId: string, botId: string) => `/api/servers/${seg(serverId)}/bots/${seg(botId)}/commands`,
  botCommand: (serverId: string, botId: string, commandId: string) =>
    `/api/servers/${seg(serverId)}/bots/${seg(botId)}/commands/${seg(commandId)}`,
  botEventEndpoint: (serverId: string, botId: string) =>
    `/api/servers/${seg(serverId)}/bots/${seg(botId)}/event-endpoint`,
  channelWebhooks: (serverId: string, channelId: string) =>
    `/api/servers/${seg(serverId)}/channels/${seg(channelId)}/webhooks`,
  channelWebhook: (serverId: string, channelId: string, webhookId: string) =>
    `/api/servers/${seg(serverId)}/channels/${seg(channelId)}/webhooks/${seg(webhookId)}`,
  channelWebhookToken: (serverId: string, channelId: string, webhookId: string) =>
    `/api/servers/${seg(serverId)}/channels/${seg(channelId)}/webhooks/${seg(webhookId)}/token`,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface RequestFailure {
  ok: false;
  /** 0 when the request never reached the server. */
  status: number;
  code: string | null;
  body: Record<string, unknown>;
}

export type RequestResult<T> = { ok: true; status: number; data: T } | RequestFailure;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

async function request<T>(
  url: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
  parse: (body: Record<string, unknown>) => T | null
): Promise<RequestResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, code: 'network', body: {} };
  }
  const body = record(await response.json().catch(() => null)) ?? {};
  if (!response.ok) return { ok: false, status: response.status, code: str(body.code), body };
  const data = parse(body);
  if (data === null) return { ok: false, status: response.status, code: 'bad_response', body };
  return { ok: true, status: response.status, data };
}

// ---------------------------------------------------------------------------
// Composer: commands per channel (cached) and invoke
// ---------------------------------------------------------------------------

const COMMAND_CACHE_TTL_MS = 60_000;
const commandCache = new Map<string, { at: number; promise: Promise<RequestResult<ChannelCommand[]>> }>();

function parseCommandList(body: Record<string, unknown>): ChannelCommand[] | null {
  if (!Array.isArray(body.commands)) return null;
  return body.commands.map(parseChannelCommand).filter((c): c is ChannelCommand => Boolean(c));
}

/**
 * The commands this member may run in a channel. One request per channel
 * per minute, shared by every caller; a failed load is not cached.
 */
export function fetchChannelCommands(
  serverId: string,
  channelId: string,
  options: { force?: boolean } = {}
): Promise<RequestResult<ChannelCommand[]>> {
  const key = `${serverId}:${channelId}`;
  const cached = commandCache.get(key);
  if (!options.force && cached && Date.now() - cached.at < COMMAND_CACHE_TTL_MS) return cached.promise;
  const promise = request(botV2Paths.channelCommands(serverId, channelId), {}, parseCommandList).then((result) => {
    if (!result.ok) commandCache.delete(key);
    return result;
  });
  commandCache.set(key, { at: Date.now(), promise });
  return promise;
}

export function invalidateChannelCommands(serverId?: string, channelId?: string): void {
  if (!serverId) return commandCache.clear();
  for (const key of commandCache.keys()) {
    if (key === `${serverId}:${channelId}` || (!channelId && key.startsWith(`${serverId}:`))) commandCache.delete(key);
  }
}

/** Interactions expire after 15 minutes (§3.2) when the response does not say. */
export { INTERACTION_TTL_MS };

export interface InvokedInteraction {
  id: string;
  status: string;
  expiresAt: string | null;
}

export function invokeCommand(
  serverId: string,
  channelId: string,
  commandId: string,
  options: Record<string, string | number | boolean>
): Promise<RequestResult<InvokedInteraction>> {
  return request(botV2Paths.invoke(serverId, channelId, commandId), { method: 'POST', body: { options } }, (body) => {
    const interaction = record(body.interaction);
    const id = str(interaction?.id);
    if (!id) return null;
    return { id, status: str(interaction?.status) ?? 'pending', expiresAt: iso(interaction?.expiresAt) };
  });
}

/**
 * The message key that explains a failed invoke. The server answers with
 * `{ error, code }`; its English `error` is never shown.
 */
export function invokeErrorKey(failure: Pick<RequestFailure, 'status' | 'code'>): string {
  switch (failure.code) {
    case 'network':
      return 'interactions.error.network';
    case 'timed_out':
      return 'interactions.error.timedOut';
    case 'command_disabled':
    case 'command_not_available':
    case 'command_not_found':
      return 'interactions.error.unavailable';
    case 'missing_permission':
      return 'interactions.error.permission';
    case 'bot_unavailable':
      return 'interactions.error.botUnavailable';
    case 'invalid_options':
    case 'invalid_request':
      return 'interactions.error.invalidOptions';
    case 'blocked_by_moderation':
      return 'interactions.error.moderation';
    case 'rate_limited':
      return 'interactions.error.rateLimited';
    case 'bot_offline':
      return 'interactions.error.botOffline';
    // A command that drives an activity is refused like the activity
    // itself; the sentences are shared with the activities surface.
    case 'session_ended':
    case 'not_host':
    case 'voice_required':
    case 'activity_exists':
      return SHARED_REFUSAL_KEYS[failure.code];
    default:
      break;
  }
  if (failure.status === 401) return 'interactions.error.signIn';
  if (failure.status === 403) return 'interactions.error.forbidden';
  if (failure.status === 404) return 'interactions.error.unavailable';
  if (failure.status === 429) return 'interactions.error.rateLimited';
  return 'interactions.error.generic';
}

// ---------------------------------------------------------------------------
// The `user:{uid}` topic: ephemeral answers and interaction status
// ---------------------------------------------------------------------------

export type UserInteractionEvent =
  | {
      kind: 'ephemeral';
      /** Unique per answer (an interaction may have follow-ups). */
      key: string;
      interactionId: string;
      serverId: string | null;
      channelId: string;
      content: string;
      commandName: string | null;
      bot: { id: string | null; name: string } | null;
      createdAt: string;
    }
  | { kind: 'status'; interactionId: string; status: 'answered' | 'expired' | 'failed' };

let ephemeralSequence = 0;

/**
 * One event from `user:{uid}`. Expected shape (BOT_API_V2 §3.4/§4.3):
 *   { type: 'interaction_response',
 *     interaction: { id, serverId, channelId, commandName, bot: { id, name } },
 *     response: { content, ephemeral: true }, at }
 * and `{ type: 'interaction_status', interaction: { id, status } }` for an
 * expired or failed interaction. Flat variants (`interactionId`,
 * `channelId`, `content`, `botName` at the top level) are accepted too.
 */
export function parseUserEvent(data: unknown): UserInteractionEvent | null {
  const d = record(data);
  if (!d) return null;
  const interaction = record(d.interaction) ?? {};
  const interactionId = str(interaction.id) ?? str(d.interactionId);
  if (!interactionId) return null;
  const response = record(d.response) ?? record(d.message) ?? {};
  const content = str(response.content) ?? str(d.content);
  const type = str(d.type) ?? str(d.event) ?? '';
  if (content && content.trim()) {
    if (response.ephemeral === false || d.ephemeral === false) return { kind: 'status', interactionId, status: 'answered' };
    const channelId = str(interaction.channelId) ?? str(d.channelId) ?? str(response.channelId);
    if (!channelId) return null;
    const botRaw = record(interaction.bot) ?? record(d.bot);
    const botName = str(botRaw?.name) ?? str(d.botName);
    const createdAt = iso(response.createdAt) ?? iso(d.at) ?? new Date().toISOString();
    ephemeralSequence += 1;
    return {
      kind: 'ephemeral',
      key: str(response.id) ?? `${interactionId}:${ephemeralSequence}`,
      interactionId,
      serverId: str(interaction.serverId) ?? str(d.serverId),
      channelId,
      content,
      commandName: str(interaction.commandName) ?? str(d.commandName),
      bot: botRaw || botName ? { id: str(botRaw?.id) ?? str(d.botId), name: botName ?? '' } : null,
      createdAt,
    };
  }
  const status = str(interaction.status) ?? str(d.status) ?? '';
  if (status === 'expired' || type.endsWith('expired')) return { kind: 'status', interactionId, status: 'expired' };
  if (status === 'failed' || type.endsWith('failed')) return { kind: 'status', interactionId, status: 'failed' };
  if (status === 'answered') return { kind: 'status', interactionId, status: 'answered' };
  return null;
}

// ---------------------------------------------------------------------------
// Admin → Bots: channel access, commands, event endpoint
// ---------------------------------------------------------------------------

export type ChannelAccessMode = 'all' | 'selected';

export interface AccessChannel {
  id: string;
  name: string;
  /** Limited to some roles (a private channel) — only someone who may grant it can pick it. */
  roleGated: boolean;
  /** Whether THIS admin may grant it (always true for an ungated channel). */
  grantable: boolean;
  /** The bot reaches it right now; null when the route did not say. */
  reachable: boolean | null;
}

export interface BotChannelAccess {
  /** `all`: no explicit grants (every channel without a role gate); `selected`: exactly the granted ones. */
  mode: ChannelAccessMode;
  /** The explicitly granted channels this admin can see. */
  channelIds: string[];
  /** Every text/announcement channel this admin can see; null when the route did not list them. */
  channels: AccessChannel[] | null;
  /** Grants on private channels this admin cannot see — kept as they are on save. */
  hiddenGrantCount: number;
}

function parseAccessChannel(value: unknown): AccessChannel | null {
  const raw = record(value);
  const id = str(raw?.id);
  if (!raw || !id) return null;
  return {
    id,
    name: str(raw.name) ?? id,
    roleGated: raw.gated === true || raw.roleGated === true,
    grantable: raw.grantable !== false,
    reachable: typeof raw.reachable === 'boolean' ? raw.reachable : null,
  };
}

/**
 * `GET|PUT /api/servers/{id}/bots/{botId}/channel-access` →
 * `{ access: { mode, channels: [{ id, name, type, position, gated, granted, reachable, grantable }], hiddenGrantCount } }`.
 */
function parseChannelAccess(body: Record<string, unknown>): BotChannelAccess | null {
  const access = record(body.access) ?? body;
  const list = Array.isArray(access.channels) ? access.channels : null;
  const granted = list
    ? list
        .map((c) => record(c))
        .filter((c): c is Record<string, unknown> => Boolean(c && c.granted === true && typeof c.id === 'string'))
        .map((c) => c.id as string)
    : [];
  const channelIds = Array.isArray(access.channelIds)
    ? access.channelIds.filter((id): id is string => typeof id === 'string')
    : granted;
  // The server always sends the stored mode; a reply without a known one is
  // shown as `selected` (only the listed channels) — never as "all".
  const mode: ChannelAccessMode = access.mode === 'all' ? 'all' : 'selected';
  return {
    mode,
    channelIds,
    channels: list ? list.map(parseAccessChannel).filter((c): c is AccessChannel => Boolean(c)) : null,
    hiddenGrantCount: typeof access.hiddenGrantCount === 'number' ? access.hiddenGrantCount : 0,
  };
}

export function getBotChannelAccess(serverId: string, botId: string) {
  return request(botV2Paths.botChannelAccess(serverId, botId), {}, parseChannelAccess);
}

/**
 * Replace the bot's channels: `all` sends `channelIds: null` (every
 * eligible channel); `selected` sends the chosen ids (1..500). The mode is
 * stored on the server, so `selected` with no channel left — after its
 * last channel was revoked or deleted — means the bot reaches NOTHING
 * (§1.1); the UI asks for at least one channel before saving `selected`.
 */
export function putBotChannelAccess(serverId: string, botId: string, input: { mode: ChannelAccessMode; channelIds: string[] }) {
  return request(
    botV2Paths.botChannelAccess(serverId, botId),
    { method: 'PUT', body: { channelIds: input.mode === 'all' ? null : input.channelIds } },
    parseChannelAccess
  );
}

export interface BotCommandInfo {
  id: string;
  name: string;
  description: string;
  options: CommandOption[];
  /** The bot's own restriction; null = every channel the bot can access. */
  channelIds: string[] | null;
  /** A manager's restriction on top; null = none. */
  adminChannelIds: string[] | null;
  requiredPermission: string | null;
  enabled: boolean;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : null;
}

function parseBotCommand(value: unknown): BotCommandInfo | null {
  const raw = record(value);
  const id = str(raw?.id);
  const name = str(raw?.name);
  if (!raw || !id || !name) return null;
  return {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    options: Array.isArray(raw.options)
      ? raw.options.map(parseCommandOption).filter((o): o is CommandOption => Boolean(o))
      : [],
    channelIds: stringList(raw.channelIds),
    adminChannelIds: stringList(raw.adminChannelIds),
    requiredPermission: str(raw.requiredPermission),
    enabled: raw.enabled !== false,
  };
}

export function listBotCommands(serverId: string, botId: string) {
  return request(botV2Paths.botCommands(serverId, botId), {}, (body) =>
    Array.isArray(body.commands)
      ? body.commands.map(parseBotCommand).filter((c): c is BotCommandInfo => Boolean(c))
      : null
  );
}

/**
 * The managers' switches on a registered command: `enabled`, and
 * `channelIds` — the MANAGER's restriction (stored as `adminChannelIds`,
 * intersected with the bot's own list; null lifts it).
 */
export function patchBotCommand(
  serverId: string,
  botId: string,
  commandId: string,
  patch: { enabled?: boolean; channelIds?: string[] | null }
) {
  return request(botV2Paths.botCommand(serverId, botId, commandId), { method: 'PATCH', body: patch }, (body) =>
    parseBotCommand(body.command)
  );
}

export interface BotEventEndpoint {
  url: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  updatedAt: string | null;
}

function parseEventEndpoint(body: Record<string, unknown>): { endpoint: BotEventEndpoint | null } | null {
  if (!('endpoint' in body)) return null;
  const raw = record(body.endpoint);
  if (!raw) return { endpoint: null };
  const url = str(raw.url);
  if (!url) return { endpoint: null };
  return {
    endpoint: {
      url,
      events: Array.isArray(raw.events) ? raw.events.filter((e): e is string => typeof e === 'string') : [],
      enabled: raw.enabled !== false,
      failureCount: typeof raw.failureCount === 'number' ? raw.failureCount : 0,
      disabledReason: str(raw.disabledReason),
      lastDeliveryAt: iso(raw.lastDeliveryAt),
      lastStatus: typeof raw.lastStatus === 'number' ? raw.lastStatus : null,
      updatedAt: iso(raw.updatedAt),
    },
  };
}

export function getBotEventEndpoint(serverId: string, botId: string) {
  return request(botV2Paths.botEventEndpoint(serverId, botId), {}, parseEventEndpoint);
}

/** Turn a disabled endpoint back on (resets the failure count server-side). */
export function reenableBotEventEndpoint(serverId: string, botId: string) {
  return request(botV2Paths.botEventEndpoint(serverId, botId), { method: 'PATCH', body: { enabled: true } }, parseEventEndpoint);
}

// ---------------------------------------------------------------------------
// Admin → Channels: incoming webhooks
// ---------------------------------------------------------------------------

export interface ChannelWebhook {
  id: string;
  channelId: string;
  name: string;
  enabled: boolean;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface WebhookSecret {
  webhook: ChannelWebhook;
  /** The full URL to post to — the only time it is ever shown. */
  url: string;
}

function parseWebhook(value: unknown, channelId: string): ChannelWebhook | null {
  const raw = record(value);
  const id = str(raw?.id);
  if (!raw || !id) return null;
  const creator = record(raw.createdBy);
  return {
    id,
    channelId: str(raw.channelId) ?? channelId,
    name: str(raw.name) ?? '',
    enabled: raw.enabled !== false,
    createdBy: creator && str(creator.id) ? { id: str(creator.id)!, name: str(creator.name) } : null,
    createdAt: iso(raw.createdAt),
    lastUsedAt: iso(raw.lastUsedAt),
  };
}

/**
 * The URL from a create/rotate answer: `url` when the route sends it,
 * else built from the token (`/api/webhooks/{id}/{token}`, §5.1).
 */
function parseWebhookSecret(body: Record<string, unknown>, channelId: string, origin: string): WebhookSecret | null {
  const webhook = parseWebhook(body.webhook, channelId);
  if (!webhook) return null;
  const url = str(body.url) ?? (str(body.token) ? `${origin}/api/webhooks/${seg(webhook.id)}/${seg(str(body.token)!)}` : null);
  if (!url) return null;
  return { webhook, url: url.startsWith('/') ? `${origin}${url}` : url };
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function listChannelWebhooks(serverId: string, channelId: string) {
  return request(botV2Paths.channelWebhooks(serverId, channelId), {}, (body) =>
    Array.isArray(body.webhooks)
      ? body.webhooks.map((w) => parseWebhook(w, channelId)).filter((w): w is ChannelWebhook => Boolean(w))
      : null
  );
}

export function createChannelWebhook(serverId: string, channelId: string, name: string) {
  return request(botV2Paths.channelWebhooks(serverId, channelId), { method: 'POST', body: { name } }, (body) =>
    parseWebhookSecret(body, channelId, currentOrigin())
  );
}

export function rotateChannelWebhook(serverId: string, channelId: string, webhookId: string) {
  return request(botV2Paths.channelWebhookToken(serverId, channelId, webhookId), { method: 'POST' }, (body) =>
    parseWebhookSecret(body, channelId, currentOrigin())
  );
}

export function patchChannelWebhook(serverId: string, channelId: string, webhookId: string, patch: { enabled?: boolean; name?: string }) {
  return request(botV2Paths.channelWebhook(serverId, channelId, webhookId), { method: 'PATCH', body: patch }, (body) =>
    parseWebhook(body.webhook, channelId)
  );
}

export function deleteChannelWebhook(serverId: string, channelId: string, webhookId: string) {
  return request(botV2Paths.channelWebhook(serverId, channelId, webhookId), { method: 'DELETE' }, () => ({ ok: true as const }));
}
