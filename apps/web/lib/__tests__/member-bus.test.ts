import { beforeEach, describe, expect, it, vi } from 'vitest';

const { publish, listServerIdsForUser } = vi.hoisted(() => ({
  publish: vi.fn(async (_channel: string, _payload: string) => 1),
  listServerIdsForUser: vi.fn(),
}));
vi.mock('@/lib/redis', () => ({ redis: { publish } }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@lobbyforge/db', () => ({ listServerIdsForUser }));

import {
  MEMBER_EVENT_MAX_IDS,
  memberTopicName,
  publishMembersChanged,
  publishMembersRemoved,
  publishProfileChanged,
  publishRolesChanged,
} from '@/lib/member-bus';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  publish.mockClear();
  listServerIdsForUser.mockReset();
});

function sent(): Array<[string, unknown]> {
  return publish.mock.calls.map(([channel, payload]) => [channel, JSON.parse(payload)]);
}

describe('member bus (docs/PROFILES.md "Live updates")', () => {
  it('names who changed, never what — one topic per server', () => {
    publishMembersChanged('s1', [id(1), id(1), id(2)]);
    publishMembersRemoved('s1', [id(3)]);
    publishRolesChanged('s1');
    expect(sent()).toEqual([
      [memberTopicName('s1'), { type: 'members-changed', userIds: [id(1), id(2)] }],
      [memberTopicName('s1'), { type: 'members-removed', userIds: [id(3)] }],
      [memberTopicName('s1'), { type: 'roles-changed' }],
    ]);
    expect(memberTopicName('s1')).toMatch(/^lf:[^:]+:members:s1$/);
  });

  it('a big id list goes out in chunks the gateway accepts', () => {
    publishMembersChanged('s1', Array.from({ length: MEMBER_EVENT_MAX_IDS + 1 }, (_, i) => id(i)));
    const lengths = sent().map(([, event]) => (event as { userIds: string[] }).userIds.length);
    expect(lengths).toEqual([MEMBER_EVENT_MAX_IDS, 1]);
  });

  it('a profile change reaches every community of the account', async () => {
    listServerIdsForUser.mockResolvedValue(['s1', 's2']);
    publishProfileChanged(id(7));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(sent().map(([channel]) => channel)).toEqual([memberTopicName('s1'), memberTopicName('s2')]);
  });

  it('never throws into the caller: a failed lookup or publish is only logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listServerIdsForUser.mockRejectedValue(new Error('db down'));
    expect(() => publishProfileChanged(id(7))).not.toThrow();
    publish.mockRejectedValueOnce(new Error('redis down'));
    expect(() => publishRolesChanged('s1')).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});
