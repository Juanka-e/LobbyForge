/**
 * Outgoing bot event deliveries (docs/BOT_API_V2.md §5.2).
 *
 * Each delivery is `POST <url>` with body `{ id, event, timestamp, data }`
 * and the headers
 *
 *   X-LobbyForge-Event       the event name
 *   X-LobbyForge-Delivery    the delivery id (uuid, same as body.id; retries reuse it)
 *   X-LobbyForge-Timestamp   unix seconds (same as body.timestamp)
 *   X-LobbyForge-Signature   v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *
 * The HMAC key is the endpoint secret string (UTF-8) exactly as it was
 * returned to the bot. Retries resend the identical bytes (same id, same
 * timestamp, same signature), so a receiver can dedupe on the id; the whole
 * retry schedule fits well inside the 5-minute timestamp window receivers
 * must enforce.
 *
 * Network safety: the URL must be https, and its host must resolve ONLY to
 * public addresses — checked when the endpoint is saved AND again on every
 * attempt, and the connection is pinned to the addresses just checked
 * (`ip-pinned-https.ts`), so a DNS rebind between check and connect cannot
 * reach a private service. Redirects are never followed.
 *
 * Reliability: 3 s per attempt; a timeout, network error, 408, 429 or 5xx is
 * retried after 1 s, 5 s and 30 s (initial attempt + up to 3 retries); any
 * other answer is final. A delivery that ends in failure counts once
 * against the endpoint; 20 consecutive failed deliveries switch it off
 * (`disabled_reason = 'too_many_failures'`) until a manager re-enables it.
 *
 * The queue is IN-PROCESS: deliveries waiting for a retry are lost when the
 * web process restarts (events are at-most-once by contract — a bot
 * backfills with the REST API). Interactions jump the queue.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  getActiveBotById,
  getBotEventEndpoint,
  logAction,
  recordBotEventDeliveryFailure,
  recordBotEventDeliverySuccess,
  type BotEventEndpointRow,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { fetchIpPinned, resolvePublicAddresses } from '@/lib/ip-pinned-https';
import { botHasPermission } from './permissions';

export const EVENT_DELIVERY_TIMEOUT_MS = 3_000;
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];
export const MAX_CONSECUTIVE_DELIVERY_FAILURES = 20;
export const EVENT_ENDPOINT_URL_MAX_LENGTH = 512;
/** A synchronous interaction answer is small; anything bigger is not read. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Concurrent deliveries per process — a slow endpoint cannot hold every socket. */
const MAX_CONCURRENT_DELIVERIES = 16;
/** Waiting deliveries per process; beyond this the oldest normal one is dropped. */
const MAX_QUEUED_DELIVERIES = 2_000;
const SIGNATURE_VERSION = 'v1';
const USER_AGENT = 'LobbyForge-Webhooks/1.0';

// ── secret + signature ──────────────────────────────────────────────────

/** A new signing secret: `whsec_` + 256 random bits (base64url). */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` */
export function signDelivery(secret: string, timestamp: number | string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

/** An endpoint as the bot and its managers see it — never the secret. */
export function toEventEndpointJson(row: BotEventEndpointRow) {
  return {
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    failureCount: row.failureCount,
    disabledReason: row.disabledReason,
    lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The events a bot's permissions let it receive (the default subscription). */
export function defaultEndpointEvents(permissions: readonly string[]): string[] {
  const out = ['channel_access_changed'];
  if (permissions.includes('read_messages')) out.push('message_create', 'message_update', 'message_delete');
  if (permissions.includes('read_members')) out.push('member_join', 'member_leave');
  if (permissions.includes('slash_commands')) out.push('interaction_create');
  return out;
}

// ── URL policy ──────────────────────────────────────────────────────────

export type EndpointUrlVerdict = { ok: true; url: string; hostname: string } | { ok: false; reason: string };

/**
 * Shape check (no network): https, a host name, no credentials, at most 512
 * characters. Fragments are dropped. IP literals are allowed here and judged
 * by the address check like any resolved name.
 */
export function checkEndpointUrlShape(raw: string): EndpointUrlVerdict {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > EVENT_ENDPOINT_URL_MAX_LENGTH) {
    return { ok: false, reason: `url must be 1–${EVENT_ENDPOINT_URL_MAX_LENGTH} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'url is not a valid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'url must use https' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'url must not contain credentials' };
  if (!parsed.hostname) return { ok: false, reason: 'url needs a host' };
  parsed.hash = '';
  const url = parsed.toString();
  if (url.length > EVENT_ENDPOINT_URL_MAX_LENGTH) {
    return { ok: false, reason: `url must be at most ${EVENT_ENDPOINT_URL_MAX_LENGTH} characters` };
  }
  return { ok: true, url, hostname: parsed.hostname };
}

/** Resolve the host and refuse private, loopback, link-local, metadata… addresses. */
export async function resolveEndpointAddresses(hostname: string): Promise<string[]> {
  // URL.hostname keeps IPv6 literals in brackets; the resolver wants them bare.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return resolvePublicAddresses(host);
}

/** Save-time check: shape + every resolved address is public. */
export async function validateEndpointUrl(raw: string): Promise<EndpointUrlVerdict> {
  const shape = checkEndpointUrlShape(raw);
  if (!shape.ok) return shape;
  try {
    await resolveEndpointAddresses(shape.hostname);
  } catch (err) {
    return { ok: false, reason: `url is not reachable as a public address: ${(err as Error).message}` };
  }
  return shape;
}

// ── delivery jobs ───────────────────────────────────────────────────────

export interface DeliveryResponse {
  status: number;
  body: Buffer;
}

export interface DeliveryJob {
  botId: string;
  serverId: string;
  event: string;
  /** The §4.2 `data` payload (it carries `event` too). */
  data: Record<string, unknown>;
  /** Interactions are delivered before everything else. */
  priority?: 'high';
  /**
   * Re-checked against the CURRENT bot row right before the first attempt
   * (permissions and channel access may have changed since the event was
   * queued). false → the delivery is dropped, nothing is sent.
   */
  authorize?: (bot: BotRow) => Promise<boolean> | boolean;
  /** Called with a 2xx answer (e.g. a synchronous interaction response). */
  onResponse?: (response: DeliveryResponse) => Promise<void> | void;
}

interface QueuedJob {
  job: DeliveryJob;
  deliveryId: string;
  timestamp: number;
  body: string | null;
  attempt: number;
  endpoint: BotEventEndpointRow | null;
}

const queue: QueuedJob[] = [];
let active = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

/** Queue a delivery for one bot. Never throws, never blocks the caller. */
export function enqueueDelivery(job: DeliveryJob): void {
  const entry: QueuedJob = {
    job,
    deliveryId: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    body: null,
    attempt: 0,
    endpoint: null,
  };
  if (job.priority === 'high') queue.unshift(entry);
  else queue.push(entry);
  if (queue.length > MAX_QUEUED_DELIVERIES) {
    const dropAt = queue.findIndex((q) => q.job.priority !== 'high');
    const [dropped] = queue.splice(dropAt === -1 ? queue.length - 1 : dropAt, 1);
    console.warn(`[bot-events] delivery queue full, dropped ${dropped?.job.event} for bot ${dropped?.job.botId}`);
  }
  pump();
}

function pump(): void {
  while (active < MAX_CONCURRENT_DELIVERIES && queue.length > 0) {
    const next = queue.shift()!;
    active += 1;
    void runAttempt(next)
      .catch((err) => console.error('[bot-events] delivery crashed:', (err as Error).message))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function scheduleRetry(entry: QueuedJob, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (entry.job.priority === 'high') queue.unshift(entry);
    else queue.push(entry);
    pump();
  }, delayMs);
  // A pending retry must not keep the process (or a test run) alive.
  timer.unref?.();
  timers.add(timer);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Load + authorize on the first attempt; null = drop silently. */
async function prepare(entry: QueuedJob): Promise<BotEventEndpointRow | null> {
  const { job } = entry;
  const [bot, endpoint] = await Promise.all([getActiveBotById(getDb(), job.botId), getBotEventEndpoint(getDb(), job.botId)]);
  if (!bot || !bot.enabled || bot.serverId !== job.serverId || bot.type !== 'custom') return null;
  if (!botHasPermission(bot, 'receive_events')) return null;
  if (!endpoint || !endpoint.enabled || !endpoint.events.includes(job.event)) return null;
  if (job.authorize && !(await job.authorize(bot))) return null;
  return endpoint;
}

async function runAttempt(entry: QueuedJob): Promise<void> {
  const { job } = entry;
  if (entry.attempt === 0) {
    entry.endpoint = await prepare(entry);
    if (!entry.endpoint) return;
    entry.body = JSON.stringify({ id: entry.deliveryId, event: job.event, timestamp: entry.timestamp, data: job.data });
  } else {
    // A retry honours an endpoint switched off or replaced in the meantime.
    const current = await getBotEventEndpoint(getDb(), job.botId);
    if (!current || !current.enabled || current.url !== entry.endpoint!.url || current.secret !== entry.endpoint!.secret) return;
  }
  const endpoint = entry.endpoint!;
  const body = entry.body!;
  entry.attempt += 1;

  let status: number | null = null;
  let retryable = false;
  let reason = 'error';
  try {
    const shape = checkEndpointUrlShape(endpoint.url);
    if (!shape.ok) throw Object.assign(new Error(shape.reason), { permanent: true });
    let addresses: string[];
    try {
      addresses = await resolveEndpointAddresses(shape.hostname);
    } catch (err) {
      // A host that now resolves to a private address is refused outright
      // (no retry): that is the rebinding case the check exists for.
      throw Object.assign(err as Error, { permanent: true });
    }
    const response = await fetchIpPinned(shape.url, shape.hostname, addresses, {
      method: 'POST',
      timeoutMs: EVENT_DELIVERY_TIMEOUT_MS,
      headersTimeoutMs: EVENT_DELIVERY_TIMEOUT_MS,
      totalTimeoutMs: EVENT_DELIVERY_TIMEOUT_MS,
      maxStreamBytes: MAX_RESPONSE_BYTES,
      userAgent: USER_AGENT,
      body,
      headers: {
        'content-type': 'application/json',
        'x-lobbyforge-event': job.event,
        'x-lobbyforge-delivery': entry.deliveryId,
        'x-lobbyforge-timestamp': String(entry.timestamp),
        'x-lobbyforge-signature': signDelivery(endpoint.secret, entry.timestamp, body),
      },
    });
    status = response.status;
    if (response.ok) {
      await recordBotEventDeliverySuccess(getDb(), { botId: job.botId, status });
      if (job.onResponse) {
        try {
          await job.onResponse({ status, body: response.body });
        } catch (err) {
          console.warn('[bot-events] synchronous answer not applied:', (err as Error).message);
        }
      }
      return;
    }
    retryable = isRetryableStatus(status);
    reason = `http_${status}`;
  } catch (err) {
    const permanent = Boolean((err as { permanent?: boolean }).permanent);
    retryable = !permanent;
    reason = permanent ? 'refused_address' : 'network';
  }

  if (retryable && entry.attempt <= EVENT_RETRY_DELAYS_MS.length) {
    scheduleRetry(entry, EVENT_RETRY_DELAYS_MS[entry.attempt - 1]!);
    return;
  }
  const result = await recordBotEventDeliveryFailure(getDb(), {
    botId: job.botId,
    status,
    maxFailures: MAX_CONSECUTIVE_DELIVERY_FAILURES,
    reason: 'too_many_failures',
  });
  if (result?.justDisabled) {
    console.warn(`[bot-events] endpoint of bot ${job.botId} disabled after ${MAX_CONSECUTIVE_DELIVERY_FAILURES} failed deliveries`);
    void logAction(getDb(), {
      serverId: job.serverId,
      actorUserId: null,
      action: 'bot.event_endpoint.disable',
      targetType: 'bot',
      targetId: job.botId,
      metadata: { reason: 'too_many_failures', lastStatus: status, lastError: reason },
    }).catch((err) => console.error('[audit] bot.event_endpoint.disable failed:', (err as Error).message));
  }
}

/** Test-only: drop queued and scheduled deliveries. */
export function __resetEventDelivery(): void {
  queue.length = 0;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

/** Test-only: resolves once nothing is queued or in flight (retries excluded). */
export async function __drainEventDelivery(): Promise<void> {
  for (let i = 0; i < 200 && (queue.length > 0 || active > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
