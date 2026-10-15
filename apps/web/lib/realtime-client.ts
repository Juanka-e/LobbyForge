/**
 * Browser-side WebSocket client for the LobbyForge realtime gateway.
 *
 * `RealtimeClient` opens a single WebSocket connection to the WS
 * gateway (`WS_URL` env var, default `ws://{host}:3001`) and lets the
 * caller subscribe / unsubscribe to topics. Multiple subscribers per
 * topic are supported; every handler is called on every event.
 *
 * The client handles auto-reconnect with exponential backoff (cap at
 * 30s). The backoff starts over only once a socket is authenticated
 * (`hello`): the gateway accepts every upgrade and closes a refused one
 * right after, so `open` proves nothing. A close for a missing / invalid
 * cookie (4401) or a revoked session (1008) is final — the client stops
 * and tells `onTerminalClose` listeners; 1011 (revocation store down) and
 * everything else backs off. While disconnected, new `subscribe()` calls
 * are queued and replayed on the next `open` event. Existing
 * subscriptions are remembered across reconnects. The gateway keeps no
 * backlog, so events published while the socket was down are gone:
 * `onReconnect` tells a subscriber that shows state to re-read it.
 *
 * A subscribe the gateway refused for a passing reason (`internal_error`,
 * `rate_limited`) is retried with a capped backoff while the topic still
 * has handlers; a subscription it revoked (`access_revoked`) is asked for
 * once more after a pause, and a `forbidden` answer ends it.
 *
 * Used by the room page for activity-state streaming (replaces the
 * per-session EventSource) and will be used by the future chat UI for
 * message streaming.
 */
'use client';

import { resolveBrowserRealtimeUrl } from './public-endpoints';

/**
 * Inline wire types — duplicated from `@lobbyforge/ws-gateway`'s
 * `protocol.ts` to avoid pulling Node-only deps (`ws`, `ioredis`) into
 * the browser bundle. Keep in sync with the gateway's protocol.
 */
export interface SubscribeMessage {
  type: 'subscribe';
  topic: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  topic: string;
}

export interface HelloMessage {
  type: 'hello';
  ok: true;
  uid: string;
  at: string;
}

export interface SubscribedMessage {
  type: 'subscribed';
  topic: string;
  at: string;
}

export interface UnsubscribedMessage {
  type: 'unsubscribed';
  topic: string;
  at: string;
}

export interface EventMessage {
  type: 'event';
  topic: string;
  data: unknown;
  at: string;
}

export interface ErrorMessage {
  type: 'error';
  topic?: string;
  code: 'bad_message' | 'forbidden' | 'unknown_topic' | 'rate_limited' | 'internal_error';
  message: string;
}

export interface AccessRevokedMessage {
  type: 'access_revoked';
  topic: string;
  reason: string;
  at: string;
}

/** Sent with every protocol ping (which a page never sees): proof of life. */
export interface HeartbeatMessage {
  type: 'heartbeat';
  at: string;
}

export type ServerMessage =
  | HelloMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | EventMessage
  | ErrorMessage
  | AccessRevokedMessage
  | HeartbeatMessage;

export type Topic =
  | `activity-state:${string}:${string}`
  | `chat:${string}:${string}`
  | `presence:${string}`
  | `dm:${string}`
  /** Events for one signed-in user only — ephemeral bot answers (BOT_API_V2 §4.3). */
  | `user:${string}`;

type Handler<T = unknown> = (data: T) => void;

interface QueuedMessage {
  type: 'subscribe' | 'unsubscribe';
  topic: string;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** The gateway sends a `heartbeat` frame every 30 s; two missed ones close the socket. */
const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Close codes after which reconnecting cannot help: no / invalid cookie, revoked session. */
const TERMINAL_CLOSE_CODES = new Set([4401, 1008]);
/** Re-subscribe after `internal_error` / `rate_limited`: 1 s, 2 s, … capped, a few times. */
const TOPIC_RETRY_BASE_MS = 1_000;
const TOPIC_RETRY_MAX_MS = 30_000;
const TOPIC_RETRY_MAX_ATTEMPTS = 6;
/** After `access_revoked`, ask once more after this pause. */
const ACCESS_REVOKED_RETRY_MS = 5_000;

export interface TerminalClose {
  code: number;
  reason: string;
}

interface TopicRetry {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** An `access_revoked` re-subscribe was made: a `forbidden` ends it. */
  revokedRetry: boolean;
}

function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3001';
  const envUrl = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_WS_URL) || '';
  // beta-review: a published image is built WITHOUT a WS URL, so HTTPS
  // pages fall back to the same-origin `/ws` nginx proxy instead of a
  // baked-in localhost; plain-HTTP dev pages keep the sibling :3001.
  return resolveBrowserRealtimeUrl(envUrl);
}

export interface RealtimeClientOptions {
  url?: string;
  onError?: (err: Error) => void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly subscriptions = new Map<string, Set<Handler>>();
  private readonly pendingQueue: QueuedMessage[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;
  private readonly onError: ((err: Error) => void) | undefined;
  private readonly reconnectListeners = new Set<() => void>();
  /** A socket has authenticated before: the next `hello` is a reconnect. */
  private authenticatedOnce = false;
  private wakeListenersInstalled = false;
  /** Set by a 4401 / 1008 close: no reconnects until `connect()` is called again. */
  private terminal: TerminalClose | null = null;
  private readonly terminalListeners = new Set<(close: TerminalClose) => void>();
  private readonly topicRetries = new Map<string, TopicRetry>();

  constructor(options: RealtimeClientOptions = {}) {
    this.url = options.url ?? defaultUrl();
    this.onError = options.onError;
  }

  connect(): void {
    this.installWakeListeners();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.explicitClose = false;
    // An explicit connect is a deliberate new attempt (a page mounting,
    // the user signing in again) — it lifts a terminal close, once.
    this.terminal = null;
    this.openSocket();
  }

  /**
   * Called when the gateway closes the socket for good: no or an invalid
   * session cookie (4401) or a revoked session (1008). The client stops
   * reconnecting; signing in again and calling `connect()` resumes it.
   * Returns the unsubscribe.
   */
  onTerminalClose(listener: (close: TerminalClose) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /** The close that stopped the client, or null while it is (re)connecting. */
  get terminalClose(): TerminalClose | null {
    return this.terminal;
  }

  /**
   * Called each time the socket authenticates again after a lost
   * connection (never for the first one). Returns the unsubscribe.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * The network came back (`online`) or the tab is visible again. Both
   * reset the backoff and lift the 20-attempt circuit breaker, so a
   * client that gave up while the laptop slept connects at once.
   *
   * A socket can look OPEN and be dead (the network changed under it, a
   * phone froze the page): the heartbeat would notice only after 60 s,
   * and the screen stays stale until then. `online` therefore replaces
   * the socket outright; becoming visible only reconnects one that is
   * already closed (subscribers re-read their state on their own).
   */
  wake(reason: 'online' | 'visible'): void {
    if (this.explicitClose || this.terminal) return;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      if (reason !== 'online') return;
      this.socket = null;
      this.clearHeartbeat();
      try {
        socket.close(4001, 'network changed');
      } catch {
        /* swallow */
      }
    }
    this.openSocket();
  }

  close(): void {
    this.explicitClose = true;
    this.removeWakeListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearTopicRetries();
    if (this.socket) {
      try {
        this.socket.close(1000, 'client close');
      } catch {
        /* swallow */
      }
      this.socket = null;
    }
  }

  subscribe<T = unknown>(topic: Topic, handler: Handler<T>): () => void {
    let set = this.subscriptions.get(topic);
    const isNewTopic = !set;
    if (!set) {
      set = new Set();
      this.subscriptions.set(topic, set);
    }
    set.add(handler as Handler);
    // beta-review: one wire subscription per topic, however many local
    // handlers share it (the gateway caps subscriptions per connection).
    if (isNewTopic) this.send({ type: 'subscribe', topic });
    return () => this.unsubscribe(topic, handler);
  }

  unsubscribe<T = unknown>(topic: Topic, handler: Handler<T>): void {
    const set = this.subscriptions.get(topic);
    if (!set) return;
    set.delete(handler as Handler);
    if (set.size === 0) {
      this.subscriptions.delete(topic);
      this.forgetTopicRetry(topic);
      this.send({ type: 'unsubscribe', topic });
    }
  }

  private send(msg: QueuedMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(msg));
      } catch (err) {
        this.pendingQueue.push(msg);
        this.onError?.(err as Error);
      }
    } else {
      this.pendingQueue.push(msg);
      // After a terminal close only an explicit connect() tries again.
      if (!this.socket && !this.terminal) this.connect();
    }
  }

  private openSocket(): void {
    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this.onError?.(err as Error);
      this.scheduleReconnect();
      return;
    }

    const socket = this.socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      // The backoff is NOT reset here: the gateway accepts the upgrade
      // before checking the cookie, and closes a refused socket right
      // after `open`. Only `hello` proves the connection works.
      // The subscription map is the desired state: replay it once and drop
      // the queued subscribe/unsubscribe messages (replaying both sent every
      // topic twice after each connect).
      this.pendingQueue.length = 0;
      for (const topic of this.subscriptions.keys()) {
        this.send({ type: 'subscribe', topic });
      }
      this.armHeartbeat();
    });

    socket.addEventListener('message', (ev) => {
      if (this.socket !== socket) return;
      this.armHeartbeat();
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      // `heartbeat` needs nothing more: every frame re-armed the timer above.
      if (parsed.type === 'hello') {
        this.reconnectAttempt = 0;
        // The replay below covers every topic a retry timer was waiting on.
        this.clearTopicRetryTimers();
        // The gateway authenticates the socket (an async session and
        // revocation check) before it reads any message; a subscribe sent
        // between `open` and `hello` is dropped, and the topic never
        // delivers. Replay the desired state once authenticated — a topic
        // that did get through answers `subscribed` again, harmlessly.
        for (const topic of this.subscriptions.keys()) {
          this.send({ type: 'subscribe', topic });
        }
        if (this.authenticatedOnce) this.notifyReconnect();
        this.authenticatedOnce = true;
      } else if (parsed.type === 'event') {
        const set = this.subscriptions.get(parsed.topic as Topic);
        if (!set) return;
        for (const handler of set) {
          try {
            handler(parsed.data);
          } catch (err) {
            this.onError?.(err as Error);
          }
        }
      } else if (parsed.type === 'subscribed') {
        this.forgetTopicRetry(parsed.topic);
      } else if (parsed.type === 'access_revoked') {
        this.retryRevokedTopic(parsed.topic);
      } else if (parsed.type === 'error') {
        if (parsed.code === 'internal_error' || parsed.code === 'rate_limited') {
          if (parsed.topic) this.retryTopic(parsed.topic);
        } else if (parsed.code === 'forbidden') {
          // A refused re-subscribe (after access_revoked) ends the retries.
          if (parsed.topic) this.forgetTopicRetry(parsed.topic);
          // Surface a forbidden subscribe as an error to the caller. We
          // don't drop the subscription — the caller decides.
          this.onError?.(new Error(`forbidden: ${parsed.message}`));
        } else if (parsed.topic) {
          this.forgetTopicRetry(parsed.topic);
        }
      }
    });

    socket.addEventListener('close', (ev) => {
      // A socket `wake` replaced: the new one is already in charge.
      if (this.socket !== socket) return;
      this.clearHeartbeat();
      this.clearTopicRetryTimers();
      this.socket = null;
      if (this.explicitClose) return;
      const code = typeof ev.code === 'number' ? ev.code : 0;
      if (TERMINAL_CLOSE_CODES.has(code)) {
        // Reconnecting would be refused the same way, every 500 ms.
        this.terminal = { code, reason: typeof ev.reason === 'string' ? ev.reason : '' };
        this.notifyTerminal(this.terminal);
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Browsers intentionally don't expose error details; rely on `close`.
    });
  }

  private scheduleReconnect(): void {
    if (this.explicitClose || this.terminal) return;
    if (this.reconnectTimer) return;
    // Circuit breaker: stop reconnecting after 20 consecutive failures.
    // This prevents infinite hammering when the ws-gateway is permanently
    // down (e.g., not started in the container). The client will retry on
    // the next page load, `online`, or visibilitychange → visible (wake).
    if (this.reconnectAttempt >= 20) {
      console.warn('[realtime] gave up after 20 reconnect attempts — ws-gateway may be down');
      this.subscriptions.forEach((handlers) => {
        handlers.forEach((h) => {
          if (typeof h === 'object' && h !== null && 'onError' in h) {
            (h as { onError?: (e: Error) => void }).onError?.(new Error('Realtime unavailable after 20 retries'));
          }
        });
      });
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 10)
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private notifyTerminal(close: TerminalClose): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(close);
      } catch (err) {
        this.onError?.(err as Error);
      }
    }
  }

  private topicRetry(topic: string): TopicRetry {
    let retry = this.topicRetries.get(topic);
    if (!retry) {
      retry = { attempt: 0, timer: null, revokedRetry: false };
      this.topicRetries.set(topic, retry);
    }
    return retry;
  }

  /** Re-subscribe after a passing refusal, with a capped backoff and a capped count. */
  private retryTopic(topic: string): void {
    if (!this.subscriptions.has(topic)) return;
    const retry = this.topicRetry(topic);
    if (retry.timer) return;
    if (retry.attempt >= TOPIC_RETRY_MAX_ATTEMPTS) {
      this.onError?.(new Error(`realtime: gave up re-subscribing to ${topic}`));
      return;
    }
    const delay = Math.min(TOPIC_RETRY_MAX_MS, TOPIC_RETRY_BASE_MS * 2 ** retry.attempt);
    retry.attempt += 1;
    this.scheduleTopicResubscribe(topic, retry, delay);
  }

  /**
   * The gateway dropped the subscription because access changed. Ask once
   * more after a pause (a check that failed for a passing reason revokes
   * too); if access is really gone the answer is `forbidden`, which ends it.
   */
  private retryRevokedTopic(topic: string): void {
    if (!this.subscriptions.has(topic)) return;
    const retry = this.topicRetry(topic);
    if (retry.revokedRetry || retry.timer) return;
    retry.revokedRetry = true;
    this.scheduleTopicResubscribe(topic, retry, ACCESS_REVOKED_RETRY_MS);
  }

  private scheduleTopicResubscribe(topic: string, retry: TopicRetry, delay: number): void {
    retry.timer = setTimeout(() => {
      retry.timer = null;
      // Still wanted, and on an open socket (otherwise the next `hello` replays it).
      if (!this.subscriptions.has(topic)) return;
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'subscribe', topic });
      }
    }, delay);
  }

  private forgetTopicRetry(topic: string): void {
    const retry = this.topicRetries.get(topic);
    if (!retry) return;
    if (retry.timer) clearTimeout(retry.timer);
    this.topicRetries.delete(topic);
  }

  /** Pending re-subscribes are dropped (the attempt counts stay). */
  private clearTopicRetryTimers(): void {
    for (const retry of this.topicRetries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = null;
    }
  }

  private clearTopicRetries(): void {
    this.clearTopicRetryTimers();
    this.topicRetries.clear();
  }

  private notifyReconnect(): void {
    for (const listener of this.reconnectListeners) {
      try {
        listener();
      } catch (err) {
        this.onError?.(err as Error);
      }
    }
  }

  private readonly onOnline = (): void => this.wake('online');
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') this.wake('visible');
  };

  private installWakeListeners(): void {
    if (this.wakeListenersInstalled || typeof window === 'undefined') return;
    this.wakeListenersInstalled = true;
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private removeWakeListeners(): void {
    if (!this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = false;
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private armHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      // No frame at all (not even the 30 s `heartbeat`) for HEARTBEAT_TIMEOUT —
      // the socket is dead; close it to trigger a reconnect.
      try {
        this.socket?.close(4000, 'heartbeat timeout');
      } catch {
        /* swallow */
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Test-only: surface the connection state for assertions. */
  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  /** Test-only: read the set of currently subscribed topics. */
  get subscribedTopics(): string[] {
    return Array.from(this.subscriptions.keys());
  }
}

let sharedClient: RealtimeClient | null = null;

/**
 * Module-level singleton — one connection per page load. Browsers cap
 * concurrent WS connections per origin, so we share.
 */
export function getRealtimeClient(options?: RealtimeClientOptions): RealtimeClient {
  if (!sharedClient) sharedClient = new RealtimeClient(options);
  return sharedClient;
}

export function __resetRealtimeClient(): void {
  if (sharedClient) sharedClient.close();
  sharedClient = null;
}