/**
 * AUTHZ-006 follow-up: the voice block list (lib/voice-block.ts) — key
 * shape, the 10 → 30 → 120 minute ladder, the one-hour repeat window and
 * per-connection idempotency. Redis is an in-memory fake that honours
 * SET EX/NX, INCR, EXPIRE, GET and PTTL against the (fake) clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: new Map<string, { value: string; expiresAt: number | null }>(),
}));

function live(key: string) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

vi.mock('@/lib/redis', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, ...args: Array<string | number>) => {
      const ex = args.indexOf('EX');
      if (args.includes('NX') && live(key)) return null;
      store.set(key, { value, expiresAt: ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : null });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => live(key)?.value ?? null),
    incr: vi.fn(async (key: string) => {
      const entry = live(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
    pttl: vi.fn(async (key: string) => {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return entry.expiresAt - Date.now();
    }),
  },
}));

import {
  VOICE_BLOCK_ENFORCED_AUDIT_WINDOW_SECONDS,
  VOICE_BLOCK_LADDER_SECONDS,
  VOICE_BLOCK_STRIKE_WINDOW_SECONDS,
  blockVoice,
  claimVoiceBlockEnforcedAudit,
  getVoiceBlock,
  isVoiceBlocked,
  voiceBlockKey,
  voiceBlockSecondsForStrike,
  voiceBlockServerId,
} from '../voice-block';

const SERVER_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const OTHER_SERVER_ID = '0a1b2c3d-0000-4000-8000-000000000003';
const CHANNEL_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const OTHER_CHANNEL_ID = '0a1b2c3d-0000-4000-8000-000000000004';
const USER = '0a1b2c3d-0000-4000-8000-0000000000aa';
const room = (serverId: string, channelId: string) =>
  `s_${serverId.replaceAll('-', '')}_c_${channelId.replaceAll('-', '')}`;

const MIN = 60;

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('voice block — key shape and scope', () => {
  it('keys the block by server + user (no channel), under the env prefix', () => {
    expect(voiceBlockKey(SERVER_ID, USER)).toBe(`lf:test:voice-block:${SERVER_ID}:${USER}`);
  });

  it('resolves the server from a room name the app minted, or from {serverId, channelId}', () => {
    expect(voiceBlockServerId(room(SERVER_ID, CHANNEL_ID))).toBe(SERVER_ID);
    expect(voiceBlockServerId({ serverId: SERVER_ID, channelId: CHANNEL_ID })).toBe(SERVER_ID);
    expect(voiceBlockServerId('some-other-room')).toBeNull();
  });

  it('a block from one voice channel covers every voice channel of that server, and no other server', async () => {
    await blockVoice(room(SERVER_ID, CHANNEL_ID), USER, { offenceId: 'PA_1' });
    expect(await isVoiceBlocked({ serverId: SERVER_ID, channelId: OTHER_CHANNEL_ID }, USER)).toBe(true);
    expect(await isVoiceBlocked(room(SERVER_ID, OTHER_CHANNEL_ID), USER)).toBe(true);
    expect(await isVoiceBlocked({ serverId: OTHER_SERVER_ID, channelId: CHANNEL_ID }, USER)).toBe(false);
    expect(await isVoiceBlocked({ serverId: SERVER_ID }, 'someone-else')).toBe(false);
    expect(store.has(`lf:test:voice-block:${SERVER_ID}:${USER}`)).toBe(true);
  });

  it('does nothing for a room name the app did not mint', async () => {
    expect(await blockVoice('some-other-room', USER)).toBeNull();
    expect(await getVoiceBlock('some-other-room', USER)).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('voice block — duration ladder', () => {
  it('is 10, 30, then 120 minutes, and stays at 120', () => {
    expect(VOICE_BLOCK_LADDER_SECONDS).toEqual([10 * MIN, 30 * MIN, 120 * MIN]);
    expect([1, 2, 3, 4, 9].map(voiceBlockSecondsForStrike)).toEqual([10 * MIN, 30 * MIN, 120 * MIN, 120 * MIN, 120 * MIN]);
    expect(voiceBlockSecondsForStrike(0)).toBe(10 * MIN);
  });

  it('a first offence blocks for 10 minutes, then expires', async () => {
    const result = await blockVoice(room(SERVER_ID, CHANNEL_ID), USER, { offenceId: 'PA_1' });
    expect(result).toEqual({ serverId: SERVER_ID, strike: 1, seconds: 10 * MIN });
    expect(await getVoiceBlock({ serverId: SERVER_ID }, USER)).toEqual({ retryAfterSeconds: 10 * MIN });

    vi.advanceTimersByTime((10 * MIN - 30) * 1000);
    expect(await getVoiceBlock({ serverId: SERVER_ID }, USER)).toEqual({ retryAfterSeconds: 30 });

    vi.advanceTimersByTime(31 * 1000);
    expect(await getVoiceBlock({ serverId: SERVER_ID }, USER)).toBeNull();
  });

  it('escalates 10 → 30 → 120 minutes for repeat offences within an hour after each block', async () => {
    const r = room(SERVER_ID, CHANNEL_ID);
    expect((await blockVoice(r, USER, { offenceId: 'PA_1' }))?.seconds).toBe(10 * MIN);
    vi.advanceTimersByTime((10 * MIN + 5 * MIN) * 1000); // block over, 5 min later
    expect((await blockVoice(r, USER, { offenceId: 'PA_2' }))?.seconds).toBe(30 * MIN);
    vi.advanceTimersByTime((30 * MIN + 59 * MIN) * 1000); // 59 min after the block ended
    expect(await blockVoice(r, USER, { offenceId: 'PA_3' })).toEqual({ serverId: SERVER_ID, strike: 3, seconds: 120 * MIN });
    vi.advanceTimersByTime((120 * MIN + 10 * MIN) * 1000);
    expect((await blockVoice(r, USER, { offenceId: 'PA_4' }))?.seconds).toBe(120 * MIN);
  });

  it('starts over at 10 minutes after an hour without an offence', async () => {
    const r = room(SERVER_ID, CHANNEL_ID);
    await blockVoice(r, USER, { offenceId: 'PA_1' });
    vi.advanceTimersByTime((10 * MIN + VOICE_BLOCK_STRIKE_WINDOW_SECONDS + 1) * 1000);
    expect(await blockVoice(r, USER, { offenceId: 'PA_2' })).toEqual({ serverId: SERVER_ID, strike: 1, seconds: 10 * MIN });
  });

  it('counts strikes per server', async () => {
    await blockVoice(room(SERVER_ID, CHANNEL_ID), USER, { offenceId: 'PA_1' });
    expect((await blockVoice(room(OTHER_SERVER_ID, CHANNEL_ID), USER, { offenceId: 'PA_2' }))?.seconds).toBe(10 * MIN);
  });
});

describe('voice block — idempotency and explicit lengths', () => {
  it('the same connection (offence id) counts once: a redelivery or a second bad track does not escalate', async () => {
    const r = room(SERVER_ID, CHANNEL_ID);
    await blockVoice(r, USER, { offenceId: 'PA_1' });
    vi.advanceTimersByTime(2_000);
    expect(await blockVoice(r, USER, { offenceId: 'PA_1' })).toEqual({ serverId: SERVER_ID, strike: 1, seconds: 10 * MIN - 2 });
    expect(await getVoiceBlock({ serverId: SERVER_ID }, USER)).toEqual({ retryAfterSeconds: 10 * MIN - 2 });
  });

  it('the same connection offending again after its block ran out is blocked again', async () => {
    const r = room(SERVER_ID, CHANNEL_ID);
    await blockVoice(r, USER, { offenceId: 'PA_1' });
    vi.advanceTimersByTime((10 * MIN + 1) * 1000);
    expect(await isVoiceBlocked(r, USER)).toBe(false);
    expect(await blockVoice(r, USER, { offenceId: 'PA_1' })).toEqual({ serverId: SERVER_ID, strike: 1, seconds: 10 * MIN });
    expect(await isVoiceBlocked(r, USER)).toBe(true);
  });

  it('without an offence id every call is a new strike', async () => {
    const r = room(SERVER_ID, CHANNEL_ID);
    await blockVoice(r, USER);
    expect((await blockVoice(r, USER))?.strike).toBe(2);
  });

  it('honours an explicit length but never shortens a block already in place', async () => {
    const scope = { serverId: SERVER_ID, channelId: CHANNEL_ID };
    expect((await blockVoice(scope, USER, { seconds: 90 }))?.seconds).toBe(90);
    expect(await getVoiceBlock(scope, USER)).toEqual({ retryAfterSeconds: 90 });

    // A longer block wins…
    expect((await blockVoice(scope, USER, { seconds: 3_600 }))?.seconds).toBe(3_600);
    // …and a shorter one later does not cut it down.
    expect((await blockVoice(scope, USER, { seconds: 60 }))?.seconds).toBe(3_600);
    expect(await getVoiceBlock(scope, USER)).toEqual({ retryAfterSeconds: 3_600 });
  });

  it('treats a block key without expiry (set by hand) as blocked', async () => {
    store.set(voiceBlockKey(SERVER_ID, USER), { value: '1', expiresAt: null });
    expect(await getVoiceBlock({ serverId: SERVER_ID }, USER)).toEqual({ retryAfterSeconds: 10 * MIN });
  });
});

describe('voice block — enforcement audit dedupe', () => {
  it('lets one voice.block_enforced row through per user, per server, per minute', async () => {
    expect(VOICE_BLOCK_ENFORCED_AUDIT_WINDOW_SECONDS).toBe(60);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, USER)).toBe(true);
    // A reconnect loop inside the window writes nothing more…
    vi.advanceTimersByTime(30_000);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, USER)).toBe(false);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, USER)).toBe(false);
    // …another server or another user is counted on its own…
    expect(await claimVoiceBlockEnforcedAudit(OTHER_SERVER_ID, USER)).toBe(true);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, '0a1b2c3d-0000-4000-8000-0000000000bb')).toBe(true);
    // …and the next window gets a row again.
    vi.advanceTimersByTime(31_000);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, USER)).toBe(true);
  });

  it('uses its own key, apart from the block itself', async () => {
    await claimVoiceBlockEnforcedAudit(SERVER_ID, USER);
    expect([...store.keys()]).toEqual([`lf:test:voice-block-enforced-audit:${SERVER_ID}:${USER}`]);
    expect(await isVoiceBlocked({ serverId: SERVER_ID }, USER)).toBe(false);
  });

  it('claims nothing without a server or user', async () => {
    expect(await claimVoiceBlockEnforcedAudit('', USER)).toBe(false);
    expect(await claimVoiceBlockEnforcedAudit(SERVER_ID, '')).toBe(false);
    expect(store.size).toBe(0);
  });
});
