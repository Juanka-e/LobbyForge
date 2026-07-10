/**
 * Tests for the per-connection subscription manager.
 *
 * The manager is a thin wrapper over the Redis subscriber pool that
 * adds idempotency: a re-subscribe must not bump the underlying
 * refcount, and a remove() of an unknown topic is a no-op.
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

import { ConnectionSubscriptions } from '../subscriptions.js';

beforeEach(() => {
  mocks.release.mockClear();
  mocks.acquire.mockClear();
  mocks.reset.mockClear();
});

describe('ConnectionSubscriptions', () => {
  it('acquires on first subscribe', () => {
    const subs = new ConnectionSubscriptions();
    const isNew = subs.add('activity-state:srv:abc', () => undefined);
    expect(isNew).toBe(true);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on re-subscribe', () => {
    const subs = new ConnectionSubscriptions();
    const handler = () => undefined;
    subs.add('activity-state:srv:abc', handler);
    const isNew = subs.add('activity-state:srv:abc', handler);
    expect(isNew).toBe(false);
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
});