import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * lib/activity-host.ts — the host of a voice game who left the voice room:
 * hand-over after 60 s to the longest-present participant, abandonment
 * after 3 min (or past 60 s with nobody to take over). Pure rule first,
 * then the effectful resolver (compare-and-swap write, audit, bus nudge).
 */

const db = {
  getGameSessionById: vi.fn(),
  isServerMember: vi.fn(),
  listPlayersForSession: vi.fn(),
  logAction: vi.fn(),
  transferGameSessionHost: vi.fn(),
  withGameSessionWriteLock: vi.fn(),
};
class GameSessionBusyError extends Error {}
vi.mock('@lobbyforge/db', () => ({ ...db, GameSessionBusyError }));

const observeVoiceAbsence = vi.fn();
vi.mock('@/lib/activity-voice', async () => {
  const actual = await vi.importActual<typeof import('@/lib/activity-voice')>('@/lib/activity-voice');
  return { ...actual, observeVoiceAbsence: (...args: unknown[]) => observeVoiceAbsence(...args) };
});
const publishActivityStateChange = vi.fn();
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange }));

const { decideActivityHost, resolveActivityHost, hostViewJson, HOST_ABANDON_AFTER_MS, HOST_TRANSFER_AFTER_MS } =
  await import('../activity-host');

const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_TIMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // in voice the longest, not playing
const PLAYER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // in voice, on the roster
const LATE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // joined voice last
const NOW = 10_000_000;

const room = (ids: string[]) => ids.map((userId, i) => ({ userId, joinedAtMs: 1_000 + i }));

describe('decideActivityHost (the rule)', () => {
  it('a host in the voice room keeps hosting; nothing is due', () => {
    const d = decideActivityHost({ hostUserId: HOST, participants: room([HOST, PLAYER]), rosterUserIds: [], awaySince: null, now: NOW });
    expect(d.view).toEqual({ hostUserId: HOST, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false });
    expect(d.transferDue).toBe(false);
  });

  it('within the 60 s grace: nothing moves, the panel learns when it will', () => {
    const awaySince = NOW - 30_000;
    const d = decideActivityHost({ hostUserId: HOST, participants: room([PLAYER]), rosterUserIds: [], awaySince, now: NOW });
    expect(d.transferDue).toBe(false);
    expect(d.view).toMatchObject({
      inVoice: false,
      awaySince,
      transferAt: awaySince + HOST_TRANSFER_AFTER_MS,
      abandonAt: awaySince + HOST_ABANDON_AFTER_MS,
      abandoned: false,
    });
  });

  it('after 60 s hosting is due to move: players first, then the longest in the room', () => {
    const d = decideActivityHost({
      hostUserId: HOST,
      participants: room([OLD_TIMER, PLAYER, LATE]),
      rosterUserIds: [HOST, PLAYER, LATE],
      awaySince: NOW - HOST_TRANSFER_AFTER_MS,
      now: NOW,
    });
    expect(d.transferDue).toBe(true);
    expect(d.candidates).toEqual([PLAYER, LATE, OLD_TIMER]);
    expect(d.view.abandoned).toBe(false);
  });

  it('with nobody on the roster in voice, the longest in the room takes over', () => {
    const d = decideActivityHost({
      hostUserId: HOST,
      participants: room([OLD_TIMER, LATE]),
      rosterUserIds: [HOST],
      awaySince: NOW - 61_000,
      now: NOW,
    });
    expect(d.candidates).toEqual([OLD_TIMER, LATE]);
  });

  it('abandoned after 3 minutes even when someone could take over', () => {
    const d = decideActivityHost({ hostUserId: HOST, participants: room([PLAYER]), rosterUserIds: [], awaySince: NOW - HOST_ABANDON_AFTER_MS, now: NOW });
    expect(d.view.abandoned).toBe(true);
    expect(d.transferDue).toBe(true);
  });

  it('nobody in the room to take over: abandoned once the 60 s grace is over', () => {
    const before = decideActivityHost({ hostUserId: HOST, participants: [], rosterUserIds: [], awaySince: NOW - 59_000, now: NOW });
    expect(before.view).toMatchObject({ abandoned: false, transferAt: null, abandonAt: NOW - 59_000 + HOST_TRANSFER_AFTER_MS });
    const after = decideActivityHost({ hostUserId: HOST, participants: [], rosterUserIds: [], awaySince: NOW - 60_000, now: NOW });
    expect(after.view.abandoned).toBe(true);
    expect(after.transferDue).toBe(false);
  });

  it('an unknown absence (ledger unavailable) decides nothing', () => {
    const d = decideActivityHost({ hostUserId: HOST, participants: room([PLAYER]), rosterUserIds: [], awaySince: null, now: NOW });
    expect(d.transferDue).toBe(false);
    expect(d.view.abandoned).toBe(false);
  });

  it('a session whose host account is gone hands over at once and may be ended', () => {
    const d = decideActivityHost({ hostUserId: null, participants: room([PLAYER]), rosterUserIds: [], awaySince: null, now: NOW });
    expect(d.transferDue).toBe(true);
    expect(d.view.abandoned).toBe(true);
  });

  it('hostViewJson shows times as ISO and nothing but the host id', () => {
    const json = hostViewJson({ hostUserId: HOST, inVoice: false, awaySince: 0, transferAt: 60_000, abandonAt: 180_000, abandoned: false });
    expect(json).toEqual({
      userId: HOST,
      inVoice: false,
      awaySince: '1970-01-01T00:00:00.000Z',
      transferAt: '1970-01-01T00:01:00.000Z',
      abandonAt: '1970-01-01T00:03:00.000Z',
      abandoned: false,
    });
  });
});

describe('resolveActivityHost (facts → write)', () => {
  const voicePlugin = {
    manifest: { id: 'game', name: 'Game', version: '1', type: 'game' as const, minAppVersion: '0', permissions: [], locales: ['en'], entryClient: '', catalog: { requiresVoiceRoom: true } },
    createInitialState: () => ({}),
    handleAction: (_c: unknown, s: unknown) => s,
    renderClient: () => null,
  };
  const row = { id: 'sess-1', serverId: 'srv-1', channelId: 'ch-1', pluginId: 'game', createdBy: HOST, status: 'lobby' };
  const snapshot = (ids: string[]) => ({ available: true as const, room: 's_room', participants: room(ids) });

  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset();
    observeVoiceAbsence.mockReset();
    publishActivityStateChange.mockReset();
    db.listPlayersForSession.mockResolvedValue([{ userId: HOST }, { userId: PLAYER }]);
    db.isServerMember.mockResolvedValue(true);
    db.logAction.mockResolvedValue(undefined);
    db.withGameSessionWriteLock.mockImplementation(async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => unknown) =>
      fn({ __tx: true }, { ...row, state: { hostId: HOST }, revision: 4 })
    );
    db.transferGameSessionHost.mockImplementation(async (_tx: unknown, _id: string, input: { toUserId: string; state?: unknown }) => ({
      ...row,
      createdBy: input.toUserId,
      state: input.state ?? { hostId: HOST },
      revision: 5,
    }));
  });

  it('does nothing for a plugin that does not require voice, or when LiveKit cannot be asked', async () => {
    const noVoice = { ...voicePlugin, manifest: { ...voicePlugin.manifest, catalog: { requiresVoiceRoom: false } } };
    expect(await resolveActivityHost({ db: {} as never, row, plugin: noVoice, voice: snapshot([]), ownerUserId: null })).toBeNull();
    expect(
      await resolveActivityHost({ db: {} as never, row, plugin: voicePlugin, voice: { available: false, room: 's_room' }, ownerUserId: null })
    ).toBeNull();
    expect(observeVoiceAbsence).not.toHaveBeenCalled();
  });

  it('a host in the room: the absence entry is cleared, no write', async () => {
    observeVoiceAbsence.mockResolvedValue(null);
    const result = await resolveActivityHost({ db: {} as never, row, plugin: voicePlugin, voice: snapshot([HOST, PLAYER]), ownerUserId: null });
    expect(observeVoiceAbsence).toHaveBeenCalledWith('s_room', HOST, true, expect.any(Number));
    expect(result?.view.inVoice).toBe(true);
    expect(db.withGameSessionWriteLock).not.toHaveBeenCalled();
  });

  it('moves hosting after 60 s: compare-and-swap on the old host, plugin hook, audit, panels nudged', async () => {
    observeVoiceAbsence.mockResolvedValue(NOW - 61_000);
    const onHostChange = vi.fn((state: { hostId: string }, change: { nextHostId: string }) => ({ ...state, hostId: change.nextHostId }));
    const result = await resolveActivityHost({
      db: {} as never,
      row,
      plugin: { ...voicePlugin, onHostChange } as never,
      voice: snapshot([OLD_TIMER, PLAYER]),
      ownerUserId: null,
      now: NOW,
    });
    expect(result?.transferred).toEqual({ fromUserId: HOST, toUserId: PLAYER });
    expect(result?.view).toMatchObject({ hostUserId: PLAYER, inVoice: true, abandoned: false });
    expect(onHostChange).toHaveBeenCalledWith({ hostId: HOST }, { previousHostId: HOST, nextHostId: PLAYER, now: NOW, reason: 'host_left_voice' });
    expect(db.transferGameSessionHost).toHaveBeenCalledWith({ __tx: true }, 'sess-1', {
      fromUserId: HOST,
      toUserId: PLAYER,
      state: { hostId: PLAYER },
    });
    expect(db.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'activity.host_transfer',
        actorUserId: null,
        targetId: 'sess-1',
        metadata: expect.objectContaining({ fromUserId: HOST, toUserId: PLAYER, reason: 'host_left_voice', awaySeconds: 61 }),
      })
    );
    // No identities on the bus.
    expect(publishActivityStateChange).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sessionId: 'sess-1',
      status: 'lobby',
      revision: 5,
      publicSummary: { rosterChanged: true },
    });
  });

  it('skips a candidate who is no longer a member', async () => {
    observeVoiceAbsence.mockResolvedValue(NOW - 61_000);
    db.isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId !== PLAYER);
    const result = await resolveActivityHost({ db: {} as never, row, plugin: voicePlugin, voice: snapshot([PLAYER, LATE]), ownerUserId: null, now: NOW });
    expect(result?.transferred?.toUserId).toBe(LATE);
  });

  it('two requests racing: the loser finds the host already moved and reports the session as it stands', async () => {
    observeVoiceAbsence.mockResolvedValue(NOW - 61_000);
    db.withGameSessionWriteLock.mockImplementation(async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => unknown) =>
      fn({ __tx: true }, { ...row, createdBy: PLAYER, state: {}, revision: 5 })
    );
    db.getGameSessionById.mockResolvedValue({ ...row, createdBy: PLAYER });
    const result = await resolveActivityHost({ db: {} as never, row, plugin: voicePlugin, voice: snapshot([PLAYER]), ownerUserId: null, now: NOW });
    expect(result?.transferred).toBeNull();
    expect(result?.view).toMatchObject({ hostUserId: PLAYER, inVoice: true });
    expect(db.transferGameSessionHost).not.toHaveBeenCalled();
    expect(db.logAction).not.toHaveBeenCalled();
  });

  it('the end route mode leaves an abandoned session to be ended rather than handed over', async () => {
    observeVoiceAbsence.mockResolvedValue(NOW - HOST_ABANDON_AFTER_MS);
    const result = await resolveActivityHost({
      db: {} as never,
      row,
      plugin: voicePlugin,
      voice: snapshot([PLAYER]),
      ownerUserId: null,
      now: NOW,
      skipTransferWhenAbandoned: true,
    });
    expect(result?.view.abandoned).toBe(true);
    expect(db.withGameSessionWriteLock).not.toHaveBeenCalled();
  });

  it('a busy session lock leaves hosting alone this time (no error for the caller)', async () => {
    observeVoiceAbsence.mockResolvedValue(NOW - 61_000);
    db.withGameSessionWriteLock.mockRejectedValue(new GameSessionBusyError('busy'));
    const result = await resolveActivityHost({ db: {} as never, row, plugin: voicePlugin, voice: snapshot([PLAYER]), ownerUserId: null, now: NOW });
    expect(result?.transferred).toBeNull();
    expect(result?.view.hostUserId).toBe(HOST);
  });

  it('an ended session is left alone', async () => {
    expect(
      await resolveActivityHost({ db: {} as never, row: { ...row, status: 'ended' }, plugin: voicePlugin, voice: snapshot([PLAYER]), ownerUserId: null })
    ).toBeNull();
  });
});
