import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * lib/activity-voice.ts — who is in an activity's voice room (LiveKit) and
 * since when someone has been out of it (the Redis absence ledger).
 */

const listParticipants = vi.fn();
const credentialsMissing = { value: false };
vi.mock('@/lib/livekit', () => ({
  getRoomServiceClient: () => {
    if (credentialsMissing.value) throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    return { listParticipants };
  },
}));

/** A tiny in-memory Redis: SET (EX/NX), GET, DEL and a pipeline of them. */
const store = new Map<string, string>();
const redisDown = { value: false };
function setCommand(key: string, value: string, ...args: unknown[]): 'OK' | null {
  if (args.includes('NX') && store.has(key)) return null;
  store.set(key, value);
  return 'OK';
}
const redis = {
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (redisDown.value) throw new Error('ECONNREFUSED');
    return setCommand(key, value, ...args);
  }),
  del: vi.fn(async (key: string) => {
    if (redisDown.value) throw new Error('ECONNREFUSED');
    return store.delete(key) ? 1 : 0;
  }),
  pipeline: () => {
    const ops: Array<() => unknown> = [];
    const chain = {
      set: (key: string, value: string, ...args: unknown[]) => {
        ops.push(() => setCommand(key, value, ...args));
        return chain;
      },
      get: (key: string) => {
        ops.push(() => store.get(key) ?? null);
        return chain;
      },
      exec: async () => {
        if (redisDown.value) throw new Error('ECONNREFUSED');
        return ops.map((op) => [null, op()]);
      },
    };
    return chain;
  },
};
vi.mock('@/lib/redis', () => ({ redis }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const voice = await import('../activity-voice');

beforeEach(() => {
  voice.__resetActivityVoice();
  listParticipants.mockReset();
  credentialsMissing.value = false;
  redisDown.value = false;
  store.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('participantsFromLiveKit', () => {
  it('keeps people only — no egress/agent, no hidden recorder, no disconnected or guest identity — oldest first', () => {
    const people = voice.participantsFromLiveKit([
      { identity: BOB, kind: 0, state: 2, joinedAt: BigInt(200) },
      { identity: ALICE, kind: 0, state: 1, joinedAtMs: BigInt(100_000) },
      { identity: 'EG_recorder', kind: 2, state: 2, joinedAt: BigInt(1) },
      { identity: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 4, joinedAt: BigInt(1) },
      { identity: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 0, permission: { hidden: true }, joinedAt: BigInt(1) },
      { identity: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 0, state: 3, joinedAt: BigInt(1) },
      { identity: 'g_guest_without_account', kind: 0, joinedAt: BigInt(1) },
    ]);
    expect(people).toEqual([
      { userId: ALICE, joinedAtMs: 100_000 },
      { userId: BOB, joinedAtMs: 200_000 },
    ]);
  });
});

describe('getVoiceRoomSnapshot', () => {
  it('asks LiveKit for the activity room and caches the answer briefly', async () => {
    listParticipants.mockResolvedValue([{ identity: ALICE, kind: 0, joinedAt: BigInt(5) }]);
    const first = await voice.getVoiceRoomSnapshot(SERVER, CHANNEL);
    const second = await voice.getVoiceRoomSnapshot(SERVER, CHANNEL);
    expect(first).toEqual({
      available: true,
      room: `s_${SERVER.replaceAll('-', '')}_c_${CHANNEL.replaceAll('-', '')}`,
      participants: [{ userId: ALICE, joinedAtMs: 5_000 }],
    });
    expect(second).toBe(first);
    expect(listParticipants).toHaveBeenCalledTimes(1);
    expect(voice.isInVoice(first, ALICE)).toBe(true);
    expect(voice.isInVoice(first, BOB)).toBe(false);
  });

  it('a room LiveKit does not know is an empty room', async () => {
    listParticipants.mockRejectedValue(Object.assign(new Error('requested room does not exist'), { status: 404 }));
    expect(await voice.getVoiceRoomSnapshot(SERVER, CHANNEL)).toMatchObject({ available: true, participants: [] });
  });

  it('LiveKit down or not configured → unavailable (callers fail open)', async () => {
    listParticipants.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await voice.getVoiceRoomSnapshot(SERVER, CHANNEL)).toMatchObject({ available: false });
    voice.__resetActivityVoice();
    credentialsMissing.value = true;
    const snapshot = await voice.getVoiceRoomSnapshot(SERVER, CHANNEL);
    expect(snapshot.available).toBe(false);
    expect(voice.isInVoice(snapshot, ALICE)).toBe(false);
  });

  it('pluginRequiresVoice reads the manifest flag', () => {
    const manifest = (flag?: boolean) => ({
      manifest: { id: 'x', name: 'x', version: '1', type: 'game' as const, minAppVersion: '0', permissions: [], locales: [], entryClient: '', catalog: flag === undefined ? undefined : { requiresVoiceRoom: flag } },
    });
    expect(voice.pluginRequiresVoice(manifest(true))).toBe(true);
    expect(voice.pluginRequiresVoice(manifest(false))).toBe(false);
    expect(voice.pluginRequiresVoice(manifest())).toBe(false);
    expect(voice.pluginRequiresVoice(null)).toBe(false);
  });
});

describe('the absence ledger', () => {
  const room = 's_room';

  it('a first sighting of someone absent starts the clock now; later sightings keep it', async () => {
    expect(await voice.observeVoiceAbsence(room, ALICE, false, 1_000)).toBe(1_000);
    expect(await voice.observeVoiceAbsence(room, ALICE, false, 5_000)).toBe(1_000);
  });

  it("the webhook's leave time wins over a later first sighting", async () => {
    await voice.recordVoiceLeft(room, ALICE, 400);
    expect(await voice.observeVoiceAbsence(room, ALICE, false, 9_000)).toBe(400);
  });

  it('seeing them present (or the webhook seeing them join) clears it', async () => {
    await voice.recordVoiceLeft(room, ALICE, 400);
    expect(await voice.observeVoiceAbsence(room, ALICE, true, 9_000)).toBeNull();
    expect(await voice.observeVoiceAbsence(room, ALICE, false, 10_000)).toBe(10_000);
    await voice.recordVoiceJoined(room, ALICE);
    expect(store.has(voice.voiceAwayKey(room, ALICE))).toBe(false);
  });

  it('Redis down → unknown (null), never a guess', async () => {
    redisDown.value = true;
    expect(await voice.observeVoiceAbsence(room, ALICE, false, 1_000)).toBeNull();
  });
});
