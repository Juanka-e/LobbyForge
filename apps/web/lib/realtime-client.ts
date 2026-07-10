/**
 * Browser-side WebSocket client for the LobbyForge realtime gateway.
 *
 * `RealtimeClient` opens a single WebSocket connection to the WS
 * gateway (`WS_URL` env var, default `ws://{host}:3001`) and lets the
 * caller subscribe / unsubscribe to topics. Multiple subscribers per
 * topic are supported; every handler is called on every event.
 *
 * The client handles auto-reconnect with exponential backoff (cap at
 * 30s). While disconnected, new `subscribe()` calls are queued and
 * replayed on the next `open` event. Existing subscriptions are
 * remembered across reconnects.
 *
 * Used by the room page for activity-state streaming (replaces the
 * per-session EventSource) and will be used by the future chat UI for
 * message streaming.
 */
'use client';

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
  code: 'bad_message' | 'forbidden' | 'unknown_topic' | 'rate_limited';
  message: string;
}

export type ServerMessage =
  | HelloMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | EventMessage
  | ErrorMessage;

export type Topic =
  | `activity-state:${string}:${string}`
  | `chat:${string}:${string}`
  | `presence:${string}`;

type Handler<T = unknown> = (data: T) => void;

interface QueuedMessage {
  type: 'subscribe' | 'unsubscribe';
  topic: string;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

function defaultUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3001';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const envUrl = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_WS_URL) || '';
  if (envUrl) return envUrl;
  // Default: same host as the page, port 3001. The gateway runs as a
  // sibling process in dev and as a sibling pod in prod.
  return `${proto}//${window.location.hostname}:3001`;
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

  constructor(options: RealtimeClientOptions = {}) {
    this.url = options.url ?? defaultUrl();
    this.onError = options.onError;
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.explicitClose = false;
    this.openSocket();
  }

  close(): void {
    this.explicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    if (!set) {
      set = new Set();
      this.subscriptions.set(topic, set);
    }
    set.add(handler as Handler);
    this.send({ type: 'subscribe', topic });
    return () => this.unsubscribe(topic, handler);
  }

  unsubscribe<T = unknown>(topic: Topic, handler: Handler<T>): void {
    const set = this.subscriptions.get(topic);
    if (!set) return;
    set.delete(handler as Handler);
    if (set.size === 0) {
      this.subscriptions.delete(topic);
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
      if (!this.socket) this.connect();
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

    this.socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      // Replay all current subscriptions first so the server re-binds them.
      for (const topic of this.subscriptions.keys()) {
        this.send({ type: 'subscribe', topic });
      }
      // Then flush any messages queued while disconnected.
      while (this.pendingQueue.length) {
        const msg = this.pendingQueue.shift()!;
        this.send(msg);
      }
      this.armHeartbeat();
    });

    this.socket.addEventListener('message', (ev) => {
      this.armHeartbeat();
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (parsed.type === 'event') {
        const set = this.subscriptions.get(parsed.topic as Topic);
        if (!set) return;
        for (const handler of set) {
          try {
            handler(parsed.data);
          } catch (err) {
            this.onError?.(err as Error);
          }
        }
      } else if (parsed.type === 'error' && parsed.code === 'forbidden') {
        // Surface a forbidden subscribe as an error to the caller. We
        // don't drop the subscription — the caller decides.
        this.onError?.(new Error(`forbidden: ${parsed.message}`));
      }
    });

    this.socket.addEventListener('close', () => {
      this.clearHeartbeat();
      this.socket = null;
      if (!this.explicitClose) this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      // Browsers intentionally don't expose error details; rely on `close`.
    });
  }

  private scheduleReconnect(): void {
    if (this.explicitClose) return;
    if (this.reconnectTimer) return;
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

  private armHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      // Server didn't ping us in HEARTBEAT_TIMEOUT — close to trigger reconnect.
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