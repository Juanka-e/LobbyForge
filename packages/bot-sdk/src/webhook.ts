/**
 * Incoming channel webhooks (docs/BOT_API_V2.md §5.1).
 *
 * ```ts
 * await postToWebhook(process.env.LOBBYFORGE_WEBHOOK_URL!, { content: 'Deploy finished' });
 * ```
 *
 * The URL (`https://<instance>/api/webhooks/{id}/{token}`) is the
 * credential: keep it secret, and never log it. Redirects are refused so
 * it cannot be forwarded to another host.
 */
import {
  BotNetworkError,
  BotValidationError,
  MAX_MESSAGE_LENGTH,
  toBotApiError,
  type BotApiMessage,
} from './client.js';

/** The longest display-name override a webhook post may carry. */
export const MAX_WEBHOOK_USERNAME_LENGTH = 32;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface WebhookPayload {
  /** 1–4000 characters. `@everyone` / `@here` are refused by the instance. */
  content: string;
  /** Optional display name for this post (≤ 32 characters). */
  username?: string;
}

export interface PostToWebhookOptions {
  /** Custom fetch (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `true` waits for the stored message and returns it (`?wait=true`). */
  wait?: boolean;
}

function webhookUrl(raw: unknown, wait: boolean): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BotValidationError('webhook URL is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BotValidationError('webhook URL must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BotValidationError('webhook URL must be an absolute http(s) URL');
  }
  if (url.username || url.password) throw new BotValidationError('webhook URL must not contain credentials');
  url.hash = '';
  if (wait) url.searchParams.set('wait', 'true');
  return url.toString();
}

/**
 * Post a message through an incoming webhook. Resolves with the stored
 * message when `wait: true`, else with `null` (the instance answers 204).
 * Failures throw the same typed errors as the Bot API client.
 */
export async function postToWebhook(
  url: string,
  payload: WebhookPayload,
  options: PostToWebhookOptions = {}
): Promise<BotApiMessage | null> {
  const target = webhookUrl(url, options.wait === true);
  const content = payload?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new BotValidationError('content must be a non-empty string');
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new BotValidationError(`content must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  const body: WebhookPayload = { content };
  if (payload.username !== undefined) {
    if (typeof payload.username !== 'string' || !payload.username.trim() || payload.username.length > MAX_WEBHOOK_USERNAME_LENGTH) {
      throw new BotValidationError(`username must be 1–${MAX_WEBHOOK_USERNAME_LENGTH} characters`);
    }
    body.username = payload.username;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new BotValidationError('No fetch implementation available; pass one in options.fetch');
  }
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BotNetworkError(`Webhook request timed out after ${timeoutMs} ms`, 'timeout', { cause: error });
    }
    throw new BotNetworkError('Could not reach the webhook', 'network_error', { cause: error });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok && options.wait) {
        throw new BotNetworkError('The webhook returned a response that is not JSON', 'invalid_response');
      }
    }
  }
  if (!response.ok) throw toBotApiError(response.status, parsed, response.headers);
  if (!options.wait) return null;
  const message = (parsed as { message?: unknown } | null)?.message;
  if (!message || typeof message !== 'object') {
    throw new BotNetworkError('The webhook response has no "message"', 'invalid_response');
  }
  return message as BotApiMessage;
}
