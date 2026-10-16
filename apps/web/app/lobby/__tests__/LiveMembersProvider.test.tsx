// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LobbyMember } from '@/lib/lobby-members';

const { subscribers, liveListeners, invalidateMemberProfile } = vi.hoisted(() => ({
  subscribers: new Map<string, (data: unknown) => void>(),
  liveListeners: new Set<() => void>(),
  invalidateMemberProfile: vi.fn(),
}));
vi.mock('@/lib/realtime-client', () => ({
  getRealtimeClient: () => ({
    subscribe: (topic: string, handler: (data: unknown) => void, options?: { onLive?: () => void }) => {
      subscribers.set(topic, handler);
      if (options?.onLive) liveListeners.add(options.onLive);
      return () => {
        subscribers.delete(topic);
        if (options?.onLive) liveListeners.delete(options.onLive);
      };
    },
  }),
}));
vi.mock('@/lib/member-profile', () => ({ invalidateMemberProfile }));

import { LiveMembersProvider, useLiveMembers } from '../LiveMembersProvider';

const SERVER = 'srv-1';
const TOPIC = `members:${SERVER}`;

function row(id: string, name: string, extra: Partial<LobbyMember> = {}): LobbyMember {
  return { id, name, status: 'offline', presence: 'offline', ...extra };
}

let answer: { members: LobbyMember[]; missing?: string[] } = { members: [] };
const fetchCalls: string[] = [];

function Probe() {
  const live = useLiveMembers();
  return (
    <ul>
      {live?.members.map((member) => (
        <li key={member.id} data-status={member.status} data-version={live.versions.get(member.id) ?? 0}>
          {member.name}
        </li>
      ))}
    </ul>
  );
}

async function renderProvider(initial: LobbyMember[]) {
  render(
    <LiveMembersProvider serverId={SERVER} initialMembers={initial}>
      <Probe />
    </LiveMembersProvider>
  );
  await waitFor(() => expect(subscribers.has(TOPIC)).toBe(true));
}

function emit(data: unknown) {
  act(() => subscribers.get(TOPIC)!(data));
}

beforeEach(() => {
  subscribers.clear();
  liveListeners.clear();
  invalidateMemberProfile.mockClear();
  fetchCalls.length = 0;
  answer = { members: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      return Response.json(answer);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveMembersProvider (docs/PROFILES.md "Live updates")', () => {
  it('re-reads the members an event names and keeps their live status', async () => {
    await renderProvider([row('a', 'Alice', { status: 'online', presence: 'online' }), row('b', 'Bob')]);
    answer = { members: [row('a', 'Alicia')] };
    emit({ type: 'members-changed', userIds: ['a'] });
    expect(await screen.findByText('Alicia')).toHaveAttribute('data-status', 'online');
    expect(fetchCalls).toEqual([`/api/servers/${SERVER}/lobby-members?ids=a`]);
    expect(invalidateMemberProfile).toHaveBeenCalledWith(SERVER, 'a');
    expect(screen.getByText('Alicia')).toHaveAttribute('data-version', '1');
  });

  it('a newcomer is added; a burst is read in one request', async () => {
    await renderProvider([row('a', 'Alice')]);
    answer = { members: [row('c', 'Cem'), row('d', 'Deniz')] };
    emit({ type: 'members-changed', userIds: ['c'] });
    emit({ type: 'members-changed', userIds: ['d'] });
    await screen.findByText('Deniz');
    expect(screen.getByText('Cem')).toBeInTheDocument();
    expect(fetchCalls).toEqual([`/api/servers/${SERVER}/lobby-members?ids=c,d`]);
  });

  it('removal is immediate, without a request; a named id that is gone is dropped too', async () => {
    await renderProvider([row('a', 'Alice'), row('b', 'Bob')]);
    emit({ type: 'members-removed', userIds: ['b'] });
    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
    expect(fetchCalls).toEqual([]);
    answer = { members: [], missing: ['a'] };
    emit({ type: 'members-changed', userIds: ['a'] });
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
  });

  it('a role edit, or the topic going live (first, or after a reconnect), re-reads everyone', async () => {
    await renderProvider([row('a', 'Alice', { status: 'in-voice' })]);
    answer = { members: [row('a', 'Alice'), row('b', 'Bob')] };
    emit({ type: 'roles-changed' });
    await screen.findByText('Bob');
    expect(fetchCalls).toEqual([`/api/servers/${SERVER}/lobby-members`]);
    expect(screen.getByText('Alice')).toHaveAttribute('data-status', 'in-voice');
    expect(invalidateMemberProfile).toHaveBeenCalledWith(SERVER);
    answer = { members: [row('b', 'Bob')] };
    await act(async () => {
      for (const listener of liveListeners) listener();
    });
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
    expect(fetchCalls).toHaveLength(2);
  });

  it('a change made between the page render and the topic going live is caught up', async () => {
    // The page rendered Alice under her old name; she renamed herself before
    // the gateway confirmed the topic, so no event will ever say so.
    await renderProvider([row('a', 'Alice')]);
    answer = { members: [row('a', 'Alicia')] };
    await act(async () => {
      for (const listener of liveListeners) listener();
    });
    expect(await screen.findByText('Alicia')).toBeInTheDocument();
    expect(fetchCalls).toEqual([`/api/servers/${SERVER}/lobby-members`]);
  });

  it('ignores malformed events', async () => {
    await renderProvider([row('a', 'Alice')]);
    emit(null);
    emit({ type: 'members-changed' });
    emit({ type: 'members-changed', userIds: [] });
    emit({ type: 'presence-update' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetchCalls).toEqual([]);
  });
});
