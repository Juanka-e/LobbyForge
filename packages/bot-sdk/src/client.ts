/**
 * Bot API v1 client.
 *
 * ```ts
 * import { createBotClient } from '@lobbyforge/bot-sdk';
 *
 * const bot = createBotClient({ baseUrl: 'https://chat.example.com', token: process.env.LOBBYFORGE_BOT_TOKEN! });
 * const [general] = await bot.listChannels();
 * await bot.sendMessage(general.id, 'Hello from a bot!');
 * ```
 *
 * Every call authenticates with `Authorization: Bot <token>`. Failures
 * throw a subclass of `BotApiError`, so a caller can branch on the class
 * (or on `error.code`) instead of parsing messages. Inputs are validated
 * before any request leaves the process.
 */

/** Shape of a LobbyForge bot token: `lfb_<bot id, 32 hex>_<secret, 43 base64url>`. */
export const BOT_TOKEN_PATTERN = /^lfb_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

/** The longest message the server accepts. */
export const MAX_MESSAGE_LENGTH = 4000;

/** The most messages one `readMessages` call returns. */
export const MAX_READ_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;

export function isBotTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && BOT_TOKEN_PATTERN.test(token);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class: any error response from the Bot API (or a rejected input). */
export class BotApiError extends Error {
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** Machine-readable reason, e.g. `missing_permission`. */
  readonly code: string;
  /** The rest of the error body, e.g. `{ permission: 'send_messages' }`. */
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BotApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 401 — the token is missing, malformed, revoked or rotated. */
export class BotAuthError extends BotApiError {
  constructor(message: string, code = 'unauthorized', details: Record<string, unknown> = {}) {
    super(message, 401, code, details);
    this.name = 'BotAuthError';
  }
}

/** 403 — the bot is disabled or lacks the permission the call needs. */
export class BotForbiddenError extends BotApiError {
  /** The permission that was missing, when that was the reason. */
  readonly permission: string | null;

  constructor(message: string, code = 'forbidden', details: Record<string, unknown> = {}) {
    super(message, 403, code, details);
    this.name = 'BotForbiddenError';
    this.permission = typeof details.permission === 'string' ? details.permission : null;
  }
}

/** 404 — the channel does not exist in the bot's server (or is off limits). */
export class BotNotFoundError extends BotApiError {
  constructor(message: string, code = 'not_found', details: Record<string, unknown> = {}) {
    super(message, 404, code, details);
    this.name = 'BotNotFoundError';
  }
}

/** 429 — slow down; retry after `retryAfter` seconds. */
export class BotRateLimitError extends BotApiError {
  readonly retryAfter: number;

  constructor(message: string, retryAfter: number, details: Record<string, unknown> = {}) {
    super(message, 429, 'rate_limited', details);
    this.name = 'BotRateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** 400 / 413 / 422, or an input the client refused to send. */
export class BotValidationError extends BotApiError {
  readonly issues: string[];

  constructor(message: string, status = 400, code = 'invalid_request', details: Record<string, unknown> = {}) {
    super(message, status, code, details);
    this.name = 'BotValidationError';
    this.issues = Array.isArray(details.issues)
      ? details.issues.filter((issue): issue is string => typeof issue === 'string')
      : [];
  }
}

/** 5xx — the server failed or is in maintenance (`code: 'maintenance'`). */
export class BotServerError extends BotApiError {
  constructor(message: string, status: number, code = 'server_error', details: Record<string, unknown> = {}) {
    super(message, status, code, details);
    this.name = 'BotServerError';
  }
}

/** The request never completed: network failure, timeout or unreadable reply. */
export class BotNetworkError extends BotApiError {
  constructor(message: string, code = 'network_error', options: { cause?: unknown } = {}) {
    super(message, 0, code);
    this.name = 'BotNetworkError';
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotClientOptions {
  /** The LobbyForge instance, e.g. `https://chat.example.com`. */
  baseUrl: string;
  /** The bot token shown once when the bot was created or its token rotated. */
  token: string;
  /** Custom fetch (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Abort a request after this many milliseconds. Default 15 000. */
  timeoutMs?: number;
}

export interface BotIdentity {
  id: string;
  name: string;
  type: string;
  serverId: string;
  permissions: string[];
}

export interface BotChannel {
  id: string;
  name: string;
  type: string;
  position: number;
  topic: string | null;
}

export type BotMessageAuthor =
  | { type: 'user'; id: string; name: string | null }
  | { type: 'bot'; id: string | null; name: string }
  | { type: 'unknown'; id: null; name: null };

export interface BotApiMessage {
  id: string;
  channelId: string;
  content: string;
  /** ISO-8601 */
  createdAt: string;
  editedAt: string | null;
  replyToId: string | null;
  author: BotMessageAuthor;
}

export interface ReadMessagesOptions {
  /** 1–100, default 50. */
  limit?: number;
  /** Only messages older than this instant (pagination cursor). */
  before?: string | Date;
}

export interface BotApiClient {
  /** Who this token belongs to: the bot, its server and its permissions. */
  getMe(): Promise<BotIdentity>;
  /** The channels of the bot's server it may use. Needs `read_messages` or `send_messages`. */
  listChannels(): Promise<BotChannel[]>;
  /** Recent messages, newest first. Needs `read_messages`. */
  readMessages(channelId: string, options?: ReadMessagesOptions): Promise<BotApiMessage[]>;
  /** Post a message as the bot. Needs `send_messages`. */
  sendMessage(channelId: string, content: string): Promise<BotApiMessage>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BotValidationError('baseUrl is required');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BotValidationError('baseUrl must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BotValidationError('baseUrl must be an absolute http(s) URL');
  }
  if (url.username || url.password) {
    throw new BotValidationError('baseUrl must not contain credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function assertChannelId(channelId: unknown): asserts channelId is string {
  if (typeof channelId !== 'string' || !UUID_PATTERN.test(channelId)) {
    throw new BotValidationError('channelId must be a channel UUID');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryAfterSeconds(body: Record<string, unknown>, headers: Headers): number {
  const fromBody = Number(body.retryAfter);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const fromHeader = Number(headers.get('retry-after'));
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  return 1;
}

/** Turn an error response into the matching typed error. */
export function toBotApiError(status: number, body: unknown, headers: Headers = new Headers()): BotApiError {
  const record = asRecord(body);
  const message =
    typeof record.error === 'string' && record.error
      ? record.error
      : `Bot API request failed with HTTP ${status}`;
  const code = typeof record.code === 'string' && record.code ? record.code : undefined;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'error' && key !== 'code') details[key] = value;
  }
  if (status === 401) return new BotAuthError(message, code, details);
  if (status === 403) return new BotForbiddenError(message, code, details);
  if (status === 404) return new BotNotFoundError(message, code, details);
  if (status === 429) return new BotRateLimitError(message, retryAfterSeconds(record, headers), details);
  if (status === 400 || status === 413 || status === 422) {
    return new BotValidationError(message, status, code, details);
  }
  if (status >= 500) return new BotServerError(message, status, code, details);
  return new BotApiError(message, status, code ?? 'http_error', details);
}

export function createBotClient(options: BotClientOptions): BotApiClient {
  const baseUrl = normalizeBaseUrl(options?.baseUrl);
  if (!isBotTokenFormat(options?.token)) {
    throw new BotValidationError('token is not a LobbyForge bot token (expected lfb_…)');
  }
  const token = options.token;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new BotValidationError('No fetch implementation available; pass one in options.fetch');
  }
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/bot/v1${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        // A bot token must never ride along to another origin via redirect.
        redirect: 'error',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new BotNetworkError(`Bot API request timed out after ${timeoutMs} ms`, 'timeout', { cause: error });
      }
      throw new BotNetworkError('Could not reach the Bot API', 'network_error', { cause: error });
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new BotNetworkError('The Bot API returned a response that is not JSON', 'invalid_response');
        }
      }
    }
    if (!response.ok) throw toBotApiError(response.status, parsed, response.headers);
    return asRecord(parsed);
  }

  function expectArray(body: Record<string, unknown>, key: string): unknown[] {
    const value = body[key];
    if (!Array.isArray(value)) {
      throw new BotNetworkError(`The Bot API response has no "${key}" list`, 'invalid_response');
    }
    return value;
  }

  function expectObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = body[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BotNetworkError(`The Bot API response has no "${key}"`, 'invalid_response');
    }
    return value as Record<string, unknown>;
  }

  return {
    async getMe() {
      const body = await request('GET', '/me');
      return expectObject(body, 'bot') as unknown as BotIdentity;
    },

    async listChannels() {
      const body = await request('GET', '/channels');
      return expectArray(body, 'channels') as BotChannel[];
    },

    async readMessages(channelId, readOptions = {}) {
      assertChannelId(channelId);
      const params = new URLSearchParams();
      if (readOptions.limit !== undefined) {
        const limit = readOptions.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
          throw new BotValidationError(`limit must be an integer from 1 to ${MAX_READ_LIMIT}`);
        }
        params.set('limit', String(limit));
      }
      if (readOptions.before !== undefined) {
        const before = readOptions.before instanceof Date ? readOptions.before : new Date(readOptions.before);
        if (Number.isNaN(before.getTime())) {
          throw new BotValidationError('before must be a valid date');
        }
        params.set('before', before.toISOString());
      }
      const query = params.toString();
      const body = await request('GET', `/channels/${channelId}/messages${query ? `?${query}` : ''}`);
      return expectArray(body, 'messages') as BotApiMessage[];
    },

    async sendMessage(channelId, content) {
      assertChannelId(channelId);
      if (typeof content !== 'string' || !content.trim()) {
        throw new BotValidationError('content must be a non-empty string');
      }
      if (content.length > MAX_MESSAGE_LENGTH) {
        throw new BotValidationError(`content must be at most ${MAX_MESSAGE_LENGTH} characters`);
      }
      const body = await request('POST', `/channels/${channelId}/messages`, { content });
      return expectObject(body, 'message') as unknown as BotApiMessage;
    },
  };
}
