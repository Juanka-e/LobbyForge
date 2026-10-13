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
 * Network safety: the URL must be https with a dotted host name (or an IP
 * literal), and its host must resolve ONLY to public addresses — checked
 * when the endpoint is saved AND again on every attempt, within 2 s and
 * without the libuv threadpool (`resolvePublicAddresses` with a deadline),
 * and the connection is pinned to the addresses just checked
 * (`ip-pinned-https.ts`), so a DNS rebind between check and connect cannot
 * reach a private service. Redirects are never followed. Why a URL was
 * refused is logged, never told to the bot (security review BOT-004).
 *
 * Authorization: EVERY attempt — the first, each retry — and the
 * synchronous interaction answer re-read the bot and its endpoint: still
 * enabled, still `receive_events`, the endpoint still on, subscribed and
 * the very URL + secret the delivery was signed for, plus the event's own
 * check (channel still reachable, …). A token rotate / revoke switches the
 * endpoint off (BOT-002), so nothing more leaves for the old URL.
 *
 * Reliability: 3 s per attempt; a timeout, network error, 408, 429 or 5xx is
 * retried after 1 s, 5 s and 30 s (initial attempt + up to 3 retries); any
 * other answer is final. A delivery that ends in failure counts once
 * against the endpoint; 20 consecutive failed deliveries switch it off
 * (`disabled_reason = 'too_many_failures'`) until a manager re-enables it.
 *
 * Fairness (security review BOT-003): one process serves every server, so
 * no bot may starve the others. Deliveries wait in a lane per bot, lanes
 * are grouped per server, and a free slot goes round-robin — next server,
 * then that server's next bot — interactions first within a lane. Caps: 16
 * in flight per process, 8 per server, 2 per bot; 100 waiting per bot (a
 * full lane drops ITS OWN oldest normal delivery) and 2 000 in all (the
 * longest lane gives one up). An endpoint that answers slowly (> 1 s, even
 * with a 2xx) or fails 3 times in a row is backed off — its lane waits 1 s,
 * then 2 s, 4 s … up to 60 s between attempts — until it answers quickly
 * again, so a slow-but-successful endpoint cannot hold the slots.
 *
 * The queue is IN-PROCESS: deliveries waiting for a retry are lost when the
 * web process restarts (events are at-most-once by contract — a bot
 * backfills with the REST API).
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
/** DNS for an endpoint host (save and every attempt) must answer within this. */
export const ENDPOINT_DNS_TIMEOUT_MS = 2_000;
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];
export const MAX_CONSECUTIVE_DELIVERY_FAILURES = 20;
export const EVENT_ENDPOINT_URL_MAX_LENGTH = 512;
/** A synchronous interaction answer is small; anything bigger is not read. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Concurrent deliveries per process — a slow endpoint cannot hold every socket. */
export const MAX_CONCURRENT_DELIVERIES = 16;
/** Concurrent deliveries per server: another server always has half the slots. */
export const MAX_IN_FLIGHT_PER_SERVER = 8;
/** Concurrent deliveries per bot. */
export const MAX_IN_FLIGHT_PER_BOT = 2;
/** Waiting deliveries per bot; beyond this the bot's own oldest normal one is dropped. */
export const MAX_QUEUED_PER_BOT = 100;
/** Waiting deliveries per process; beyond this the longest lane drops its oldest normal one. */
export const MAX_QUEUED_DELIVERIES = 2_000;
/** An attempt slower than this (even a 2xx) counts toward the endpoint's back-off. */
export const SLOW_DELIVERY_MS = 1_000;
/** Slow or failed attempts in a row before the endpoint is backed off. */
export const SLOW_STREAK_BEFORE_BACKOFF = 3;
const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Endpoints whose back-off state is remembered (oldest forgotten first). */
const MAX_HEALTH_ENTRIES = 10_000;
const SIGNATURE_VERSION = 'v1';
const USER_AGENT = 'LobbyForge-Webhooks/1.0';

/**
 * The one reason a bot is told when its URL does not resolve to public
 * addresses — never the resolver's error, the address or the host it saw
 * (they map the instance's network: internal IPs, Docker service names).
 */
export const ENDPOINT_NOT_PUBLIC_REASON =
  'url must resolve, over public DNS, to public internet addresses only';

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
 * Shape check (no network): https, a host name with a dot (or an IP
 * literal), no credentials, at most 512 characters. Fragments are dropped.
 * IP literals are allowed here and judged by the address check like any
 * resolved name. A single label (`postgres`, `redis`, `intranet.`) only
 * resolves inside a private network (Docker service names, search
 * domains), so it is never a public endpoint.
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
  const host = parsed.hostname.replace(/\.$/, '');
  if (!host.startsWith('[') && !host.includes('.')) {
    return { ok: false, reason: 'url needs a fully qualified domain name' };
  }
  parsed.hash = '';
  const url = parsed.toString();
  if (url.length > EVENT_ENDPOINT_URL_MAX_LENGTH) {
    return { ok: false, reason: `url must be at most ${EVENT_ENDPOINT_URL_MAX_LENGTH} characters` };
  }
  return { ok: true, url, hostname: parsed.hostname };
}

/**
 * Resolve the host (within `ENDPOINT_DNS_TIMEOUT_MS`, off the threadpool)
 * and refuse private, loopback, link-local, metadata… addresses.
 */
export async function resolveEndpointAddresses(hostname: string): Promise<string[]> {
  // URL.hostname keeps IPv6 literals in brackets; the resolver wants them bare.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return resolvePublicAddresses(host, { timeoutMs: ENDPOINT_DNS_TIMEOUT_MS });
}

/**
 * Save-time check: shape + every resolved address is public. A refusal of
 * the address says only `ENDPOINT_NOT_PUBLIC_REASON`; the detail goes to
 * the server log (JSON-quoted: the host is the bot's input).
 */
export async function validateEndpointUrl(raw: string): Promise<EndpointUrlVerdict> {
  const shape = checkEndpointUrlShape(raw);
  if (!shape.ok) return shape;
  try {
    await resolveEndpointAddresses(shape.hostname);
  } catch (err) {
    console.warn(
      `[bot-events] endpoint refused at save: host ${JSON.stringify(shape.hostname)}: ${JSON.stringify((err as Error).message)}`
    );
    return { ok: false, reason: ENDPOINT_NOT_PUBLIC_REASON };
  }
  return shape;
}

// ── delivery jobs ───────────────────────────────────────────────────────

export interface DeliveryResponse {
  status: number;
  body: Buffer;
  /** The bot row as re-read and re-authorized right after the answer arrived. */
  bot: BotRow;
}

export interface DeliveryJob {
  botId: string;
  serverId: string;
  event: string;
  /** The §4.2 `data` payload (it carries `event` too). */
  data: Record<string, unknown>;
  /** Interactions are delivered before the bot's other deliveries. */
  priority?: 'high';
  /**
   * Re-checked against the CURRENT bot row before every attempt and before
   * a synchronous answer is applied (permissions and channel access may
   * have changed since the event was queued). false → the delivery is
   * dropped, nothing is sent.
   */
  authorize?: (bot: BotRow) => Promise<boolean> | boolean;
  /** Called with a 2xx answer (e.g. a synchronous interaction response), after re-authorization. */
  onResponse?: (response: DeliveryResponse) => Promise<void> | void;
}

interface QueuedJob {
  job: DeliveryJob;
  deliveryId: string;
  timestamp: number;
  body: string | null;
  attempt: number;
  /** The endpoint the first attempt signed for; later steps must still find exactly it. */
  endpoint: BotEventEndpointRow | null;
}

/** One bot's waiting deliveries. */
interface BotLane {
  botId: string;
  high: QueuedJob[];
  normal: QueuedJob[];
  active: number;
}

/** One server's lanes, served round-robin. */
interface ServerLane {
  serverId: string;
  bots: Map<string, BotLane>;
  ring: string[];
  cursor: number;
  active: number;
}

interface EndpointHealth {
  slowStreak: number;
  backoffUntil: number;
}

const servers = new Map<string, ServerLane>();
let serverRing: string[] = [];
let serverCursor = 0;
let active = 0;
let queued = 0;
const health = new Map<string, EndpointHealth>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let wakeAt = 0;

function laneSize(lane: BotLane): number {
  return lane.high.length + lane.normal.length;
}

function laneFor(serverId: string, botId: string): { server: ServerLane; lane: BotLane } {
  let server = servers.get(serverId);
  if (!server) {
    server = { serverId, bots: new Map(), ring: [], cursor: 0, active: 0 };
    servers.set(serverId, server);
    serverRing.push(serverId);
  }
  let lane = server.bots.get(botId);
  if (!lane) {
    lane = { botId, high: [], normal: [], active: 0 };
    server.bots.set(botId, lane);
    server.ring.push(botId);
  }
  return { server, lane };
}

/** Forget a lane (and its server) once nothing waits or runs there. */
function prune(server: ServerLane, lane: BotLane): void {
  if (lane.active > 0 || laneSize(lane) > 0 || server.bots.get(lane.botId) !== lane) return;
  server.bots.delete(lane.botId);
  const at = server.ring.indexOf(lane.botId);
  if (at !== -1) {
    server.ring.splice(at, 1);
    if (at < server.cursor) server.cursor -= 1;
    if (server.cursor >= server.ring.length) server.cursor = 0;
  }
  if (server.bots.size > 0 || server.active > 0 || servers.get(server.serverId) !== server) return;
  servers.delete(server.serverId);
  const sAt = serverRing.indexOf(server.serverId);
  if (sAt !== -1) {
    serverRing.splice(sAt, 1);
    if (sAt < serverCursor) serverCursor -= 1;
    if (serverCursor >= serverRing.length) serverCursor = 0;
  }
}

/** Drop the lane's oldest normal delivery (an interaction only when nothing else waits). */
function dropOldest(server: ServerLane, lane: BotLane, why: string): void {
  const dropped = lane.normal.length > 0 ? lane.normal.shift() : lane.high.shift();
  if (!dropped) return;
  queued -= 1;
  console.warn(`[bot-events] ${why}: dropped ${dropped.job.event} for bot ${dropped.job.botId}`);
  prune(server, lane);
}

function enqueue(entry: QueuedJob): void {
  const { server, lane } = laneFor(entry.job.serverId, entry.job.botId);
  (entry.job.priority === 'high' ? lane.high : lane.normal).push(entry);
  queued += 1;
  if (laneSize(lane) > MAX_QUEUED_PER_BOT) dropOldest(server, lane, 'bot delivery queue full');
  if (queued > MAX_QUEUED_DELIVERIES) {
    // The process-wide bound costs the heaviest bot, not whoever is oldest.
    let longest: { server: ServerLane; lane: BotLane } | null = null;
    for (const s of servers.values()) {
      for (const l of s.bots.values()) {
        if (!longest || laneSize(l) > laneSize(longest.lane)) longest = { server: s, lane: l };
      }
    }
    if (longest) dropOldest(longest.server, longest.lane, 'delivery queue full');
  }
}

function backoffUntil(botId: string): number {
  return health.get(botId)?.backoffUntil ?? 0;
}

/** Record one attempt: quick 2xx → healthy (back-off cleared); slow or failed → toward a back-off. */
function noteAttempt(botId: string, healthy: boolean, now: number = Date.now()): void {
  if (healthy) {
    health.delete(botId);
    return;
  }
  const state = health.get(botId) ?? { slowStreak: 0, backoffUntil: 0 };
  state.slowStreak += 1;
  if (state.slowStreak >= SLOW_STREAK_BEFORE_BACKOFF) {
    const doublings = Math.min(state.slowStreak - SLOW_STREAK_BEFORE_BACKOFF, 16);
    state.backoffUntil = now + Math.min(BACKOFF_BASE_MS * 2 ** doublings, BACKOFF_MAX_MS);
  }
  // Re-insert: the Map's order is least recently touched first.
  health.delete(botId);
  health.set(botId, state);
  if (health.size > MAX_HEALTH_ENTRIES) {
    const oldest = health.keys().next().value;
    if (oldest !== undefined) health.delete(oldest);
  }
}

/** A new endpoint (saved again, re-enabled) starts without the old one's back-off. */
export function resetEndpointBackoff(botId: string): void {
  health.delete(botId);
}

/** The next delivery to start: round-robin over servers, then over that server's bots. */
function nextPick(now: number): { server: ServerLane; lane: BotLane; entry: QueuedJob } | null {
  const serverCount = serverRing.length;
  for (let i = 0; i < serverCount; i++) {
    const sIdx = (serverCursor + i) % serverCount;
    const server = servers.get(serverRing[sIdx]!);
    if (!server || server.active >= MAX_IN_FLIGHT_PER_SERVER) continue;
    const botCount = server.ring.length;
    for (let j = 0; j < botCount; j++) {
      const bIdx = (server.cursor + j) % botCount;
      const lane = server.bots.get(server.ring[bIdx]!);
      if (!lane || lane.active >= MAX_IN_FLIGHT_PER_BOT || laneSize(lane) === 0) continue;
      if (backoffUntil(lane.botId) > now) continue;
      const entry = (lane.high.length > 0 ? lane.high : lane.normal).shift()!;
      queued -= 1;
      server.cursor = (bIdx + 1) % botCount;
      serverCursor = (sIdx + 1) % serverCount;
      return { server, lane, entry };
    }
  }
  return null;
}

/** When only backed-off lanes have work, come back when the first back-off ends. */
function armWake(now: number): void {
  if (queued === 0 || active >= MAX_CONCURRENT_DELIVERIES) return;
  let earliest = Infinity;
  for (const server of servers.values()) {
    for (const lane of server.bots.values()) {
      if (laneSize(lane) === 0) continue;
      const until = backoffUntil(lane.botId);
      if (until > now && until < earliest) earliest = until;
    }
  }
  if (earliest === Infinity) return;
  if (wakeTimer && wakeAt <= earliest) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeAt = earliest;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    pump();
  }, Math.max(1, earliest - now));
  wakeTimer.unref?.();
}

function pump(): void {
  const now = Date.now();
  while (active < MAX_CONCURRENT_DELIVERIES && queued > 0) {
    const pick = nextPick(now);
    if (!pick) break;
    const { server, lane, entry } = pick;
    active += 1;
    server.active += 1;
    lane.active += 1;
    void runAttempt(entry)
      .catch((err) => console.error('[bot-events] delivery crashed:', (err as Error).message))
      .finally(() => {
        active -= 1;
        server.active -= 1;
        lane.active -= 1;
        prune(server, lane);
        pump();
      });
  }
  armWake(now);
}

/** Queue a delivery for one bot. Never throws, never blocks the caller. */
export function enqueueDelivery(job: DeliveryJob): void {
  enqueue({
    job,
    deliveryId: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    body: null,
    attempt: 0,
    endpoint: null,
  });
  pump();
}

function scheduleRetry(entry: QueuedJob, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    enqueue(entry);
    pump();
  }, delayMs);
  // A pending retry must not keep the process (or a test run) alive.
  timer.unref?.();
  timers.add(timer);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Re-read and re-check everything a delivery depends on — before every
 * attempt and before a synchronous answer. null = drop silently.
 */
async function authorizeDelivery(entry: QueuedJob): Promise<{ bot: BotRow; endpoint: BotEventEndpointRow } | null> {
  const { job } = entry;
  const [bot, endpoint] = await Promise.all([getActiveBotById(getDb(), job.botId), getBotEventEndpoint(getDb(), job.botId)]);
  if (!bot || !bot.enabled || bot.serverId !== job.serverId || bot.type !== 'custom') return null;
  if (!botHasPermission(bot, 'receive_events')) return null;
  if (!endpoint || !endpoint.enabled || !endpoint.events.includes(job.event)) return null;
  // A retry (or this attempt's answer) belongs to the endpoint it was signed for:
  // replaced — a new URL, or a new secret from a save with a new token — means drop.
  if (entry.endpoint && (endpoint.url !== entry.endpoint.url || endpoint.secret !== entry.endpoint.secret)) return null;
  if (job.authorize && !(await job.authorize(bot))) return null;
  return { bot, endpoint };
}

async function runAttempt(entry: QueuedJob): Promise<void> {
  const { job } = entry;
  const current = await authorizeDelivery(entry);
  if (!current) return;
  if (entry.attempt === 0) {
    entry.endpoint = current.endpoint;
    entry.body = JSON.stringify({ id: entry.deliveryId, event: job.event, timestamp: entry.timestamp, data: job.data });
  }
  const endpoint = entry.endpoint!;
  const body = entry.body!;
  entry.attempt += 1;

  let status: number | null = null;
  let retryable = false;
  let reason = 'error';
  const startedAt = Date.now();
  try {
    const shape = checkEndpointUrlShape(endpoint.url);
    if (!shape.ok) throw Object.assign(new Error(shape.reason), { permanent: true });
    let addresses: string[];
    try {
      addresses = await resolveEndpointAddresses(shape.hostname);
    } catch (err) {
      // A host that now resolves to a private address (or not within the
      // deadline) is refused outright, no retry: the rebinding case.
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
      noteAttempt(job.botId, Date.now() - startedAt <= SLOW_DELIVERY_MS);
      await recordBotEventDeliverySuccess(getDb(), { botId: job.botId, status });
      if (job.onResponse) {
        // The answer acts AS the bot (a public one is a channel message):
        // the bot, its endpoint and the job's own check must all still hold.
        const now = await authorizeDelivery(entry);
        if (!now) {
          console.warn(`[bot-events] synchronous answer of bot ${job.botId} dropped: no longer authorized`);
          return;
        }
        try {
          await job.onResponse({ status, body: response.body, bot: now.bot });
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
  noteAttempt(job.botId, false);

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

/** Test-only: drop queued and scheduled deliveries and every endpoint's back-off. */
export function __resetEventDelivery(): void {
  servers.clear();
  serverRing = [];
  serverCursor = 0;
  queued = 0;
  health.clear();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
}

/** Test-only: resolves once nothing is queued or in flight (retries and back-offs excluded). */
export async function __drainEventDelivery(): Promise<void> {
  for (let i = 0; i < 200 && (queued > 0 || active > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Test-only: what the scheduler holds right now. */
export function __eventDeliveryState(): {
  active: number;
  queued: number;
  lanes: Array<{ serverId: string; botId: string; waiting: number; active: number }>;
  backoffUntil: (botId: string) => number;
} {
  const lanes: Array<{ serverId: string; botId: string; waiting: number; active: number }> = [];
  for (const server of servers.values()) {
    for (const lane of server.bots.values()) {
      lanes.push({ serverId: server.serverId, botId: lane.botId, waiting: laneSize(lane), active: lane.active });
    }
  }
  return { active, queued, lanes, backoffUntil };
}
