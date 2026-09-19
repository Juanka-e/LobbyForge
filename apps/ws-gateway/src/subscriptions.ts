/**
 * Per-connection subscription manager.
 *
 * Tracks which topics a single WebSocket has subscribed to, with
 * idempotent `add` (a re-subscribe to the same topic must not double
 * the Redis refcount) and `remove` (a no-op for unknown topics).
 *
 * `closeAll()` releases every held subscription — called when the
 * socket closes (regardless of whether it was a clean close, an
 * unauthorized subscribe, or a protocol error).
 *
 * beta-review (S6): subscriptions are CAPPED per connection and per
 * user across all of that user's connections, so one member cannot pin
 * an unbounded number of live Redis subscriptions. After `closeAll()`
 * the manager refuses new topics — a subscribe whose authorization was
 * still in flight when the socket closed must not leak a handle.
 */
import { acquireTopicSubscription } from './redis-subscriber.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_MAX_TOPICS_PER_CONNECTION = envInt('WS_MAX_SUBS_PER_CONN', 64);
export const DEFAULT_MAX_TOPICS_PER_USER = envInt('WS_MAX_SUBS_PER_USER', 256);

/** userId → live subscriptions across every connection of that user. */
const userTopicCounts = new Map<string, number>();

export type SubscriptionCapacityError = 'connection_limit' | 'user_limit';
export type AddResult = 'added' | 'exists' | 'closed' | SubscriptionCapacityError;

/** Metadata captured at authorization time (e.g. the resolved channel). */
export interface TopicMeta {
  channelId?: string;
}

export interface ConnectionSubscriptionsOptions {
  /** Owner of the connection — enables the per-user cap. */
  userId?: string;
  maxTopics?: number;
  maxTopicsPerUser?: number;
}

export class ConnectionSubscriptions {
  private readonly handles = new Map<string, { release: () => void; meta: TopicMeta }>();
  private closed = false;
  private readonly userId: string | undefined;
  private readonly maxTopics: number;
  private readonly maxTopicsPerUser: number;

  constructor(options: ConnectionSubscriptionsOptions = {}) {
    this.userId = options.userId;
    this.maxTopics = options.maxTopics ?? DEFAULT_MAX_TOPICS_PER_CONNECTION;
    this.maxTopicsPerUser = options.maxTopicsPerUser ?? DEFAULT_MAX_TOPICS_PER_USER;
  }

  /**
   * Cheap pre-check (before the DB authorization round trip). `add()`
   * re-checks atomically, since subscribes are processed concurrently.
   */
  capacityError(): SubscriptionCapacityError | null {
    if (this.handles.size >= this.maxTopics) return 'connection_limit';
    if (this.userId && (userTopicCounts.get(this.userId) ?? 0) >= this.maxTopicsPerUser) {
      return 'user_limit';
    }
    return null;
  }

  /**
   * `'added'` for a new subscription, `'exists'` if the topic was
   * already held (idempotent — no Redis refcount bump), `'closed'` once
   * the connection is gone, or the cap that refused it.
   */
  add(topic: string, handler: (raw: string) => void, meta: TopicMeta = {}): AddResult {
    if (this.closed) return 'closed';
    if (this.handles.has(topic)) return 'exists';
    const capacity = this.capacityError();
    if (capacity) return capacity;
    const handle = acquireTopicSubscription(topic, handler);
    this.handles.set(topic, { release: handle.release, meta });
    if (this.userId) {
      userTopicCounts.set(this.userId, (userTopicCounts.get(this.userId) ?? 0) + 1);
    }
    return 'added';
  }

  remove(topic: string): void {
    const existing = this.handles.get(topic);
    if (!existing) return;
    this.handles.delete(topic);
    this.releaseUserSlot();
    existing.release();
  }

  closeAll(): void {
    this.closed = true;
    for (const [, handle] of this.handles) {
      this.releaseUserSlot();
      try {
        handle.release();
      } catch {
        /* swallow — close is best-effort */
      }
    }
    this.handles.clear();
  }

  has(topic: string): boolean {
    return this.handles.has(topic);
  }

  meta(topic: string): TopicMeta | undefined {
    return this.handles.get(topic)?.meta;
  }

  topics(): string[] {
    return Array.from(this.handles.keys());
  }

  get size(): number {
    return this.handles.size;
  }

  private releaseUserSlot(): void {
    if (!this.userId) return;
    const count = userTopicCounts.get(this.userId) ?? 0;
    if (count <= 1) userTopicCounts.delete(this.userId);
    else userTopicCounts.set(this.userId, count - 1);
  }
}

/** Test/introspection: live subscriptions held by a user. */
export function __userTopicCount(userId: string): number {
  return userTopicCounts.get(userId) ?? 0;
}

/** Test-only: clear the per-user counters. */
export function __resetUserTopicCounts(): void {
  userTopicCounts.clear();
}
