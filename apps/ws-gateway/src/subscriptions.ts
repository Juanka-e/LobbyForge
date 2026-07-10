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
 */
import { acquireTopicSubscription } from './redis-subscriber.js';

export class ConnectionSubscriptions {
  private readonly handles = new Map<string, { release: () => void }>();

  /**
   * Returns `true` if this is a new subscription, `false` if the topic
   * was already held (idempotent — we don't bump the Redis refcount
   * for re-subscribes).
   */
  add(topic: string, handler: (raw: string) => void): boolean {
    const existing = this.handles.get(topic);
    if (existing) return false;
    const handle = acquireTopicSubscription(topic, handler);
    this.handles.set(topic, handle);
    return true;
  }

  remove(topic: string): void {
    const existing = this.handles.get(topic);
    if (!existing) return;
    existing.release();
    this.handles.delete(topic);
  }

  closeAll(): void {
    for (const [, handle] of this.handles) {
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

  topics(): string[] {
    return Array.from(this.handles.keys());
  }
}