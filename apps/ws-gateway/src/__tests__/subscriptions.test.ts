/**
 * Tests for the per-connection subscription manager.
 *
 * The manager is a thin wrapper over the Redis subscriber pool that
 * adds idempotency: a re-subscribe must not bump the underlying
 * refcount, and a remove() of an unknown topic is a no-op.
 *
 * beta-review (S6): it also caps subscriptions per connection and per
 * user (across connections), and refuses topics after closeAll().
 *
 * We mock the pool so the test doesn't touch Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const release = vi.fn();
  const acquire = vi.fn((_topic: string, _handler: (raw: string) => void) => ({ release }));
  const reset = vi.fn();
  return { release, acquire, reset };
});

vi.mock('../redis-subscriber.js', () => ({
  acquireTopicSubscription: mocks.acquire,
  __resetSubscriberState: mocks.reset,
}));

import {
  ConnectionSubscriptions,
  __resetUserTopicCounts,
  __userTopicCount,
} from '../subscriptions.js';

beforeEach(() => {
  mocks.release.mockClear();
  mocks.acquire.mockClear();
  mocks.reset.mockClear();
  __resetUserTopicCounts();
});

describe('ConnectionSubscriptions', () => {
  it('acquires on first subscribe', () => {
    const subs = new ConnectionSubscriptions();
    const result = subs.add('activity-state:srv:abc', () => undefined);
    expect(result).toBe('added');
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on re-subscribe', () => {
    const subs = new ConnectionSubscriptions();
    const handler = () => undefined;
    subs.add('activity-state:srv:abc', handler);
    const result = subs.add('activity-state:srv:abc', handler);
    expect(result).toBe('exists');
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
  });

  it('remove() releases the underlying handle', () => {
    const subs = new ConnectionSubscriptions();
    subs.add('chat:srv:abc', () => undefined);
    subs.remove('chat:srv:abc');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('remove() on an unknown topic is a no-op', () => {
    const subs = new ConnectionSubscriptions();
    subs.remove('chat:srv:abc');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('closeAll() releases every held subscription', () => {
    const subs = new ConnectionSubscriptions();
    subs.add('chat:srv:a', () => undefined);
    subs.add('chat:srv:b', () => undefined);
    subs.add('activity-state:srv:c', () => undefined);
    subs.closeAll();
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it('has() reports current subscriptions', () => {
    const subs = new ConnectionSubscriptions();
    expect(subs.has('chat:srv:abc')).toBe(false);
    subs.add('chat:srv:abc', () => undefined);
    expect(subs.has('chat:srv:abc')).toBe(true);
  });

  it('topics() lists currently subscribed topics', () => {
    const subs = new ConnectionSubscriptions();
    subs.add('chat:srv:a', () => undefined);
    subs.add('chat:srv:b', () => undefined);
    expect(subs.topics().sort()).toEqual(['chat:srv:a', 'chat:srv:b']);
  });

  it('keeps per-topic metadata (the authorized channel)', () => {
    const subs = new ConnectionSubscriptions();
    subs.add('activity-state:srv:sess', () => undefined, { channelId: 'ch-1' });
    expect(subs.meta('activity-state:srv:sess')).toEqual({ channelId: 'ch-1' });
    expect(subs.meta('chat:srv:none')).toBeUndefined();
  });
});

describe('ConnectionSubscriptions — beta-review S6 caps', () => {
  it('caps subscriptions per connection', () => {
    const subs = new ConnectionSubscriptions({ maxTopics: 2 });
    expect(subs.add('chat:srv:a', () => undefined)).toBe('added');
    expect(subs.add('chat:srv:b', () => undefined)).toBe('added');
    expect(subs.capacityError()).toBe('connection_limit');
    expect(subs.add('chat:srv:c', () => undefined)).toBe('connection_limit');
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    // Freeing a slot lets the next topic in.
    subs.remove('chat:srv:a');
    expect(subs.add('chat:srv:c', () => undefined)).toBe('added');
  });

  it('caps subscriptions per user ACROSS connections', () => {
    const a = new ConnectionSubscriptions({ userId: 'u1', maxTopics: 10, maxTopicsPerUser: 3 });
    const b = new ConnectionSubscriptions({ userId: 'u1', maxTopics: 10, maxTopicsPerUser: 3 });
    const other = new ConnectionSubscriptions({ userId: 'u2', maxTopics: 10, maxTopicsPerUser: 3 });
    a.add('chat:srv:1', () => undefined);
    a.add('chat:srv:2', () => undefined);
    b.add('chat:srv:3', () => undefined);
    expect(__userTopicCount('u1')).toBe(3);
    expect(b.add('chat:srv:4', () => undefined)).toBe('user_limit');
    expect(a.capacityError()).toBe('user_limit');
    // Another user is unaffected.
    expect(other.add('chat:srv:1', () => undefined)).toBe('added');
    // Closing one connection returns its slots to the user budget.
    a.closeAll();
    expect(__userTopicCount('u1')).toBe(1);
    expect(b.add('chat:srv:4', () => undefined)).toBe('added');
  });

  it('refuses new topics after closeAll() (no leaked handle from an in-flight subscribe)', () => {
    const subs = new ConnectionSubscriptions({ userId: 'u1' });
    subs.closeAll();
    expect(subs.add('chat:srv:late', () => undefined)).toBe('closed');
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(__userTopicCount('u1')).toBe(0);
  });

  it('remove() and closeAll() never double-release the user budget', () => {
    const subs = new ConnectionSubscriptions({ userId: 'u1' });
    subs.add('chat:srv:a', () => undefined);
    subs.add('chat:srv:b', () => undefined);
    subs.remove('chat:srv:a');
    subs.remove('chat:srv:a');
    subs.closeAll();
    subs.closeAll();
    expect(__userTopicCount('u1')).toBe(0);
  });
});
