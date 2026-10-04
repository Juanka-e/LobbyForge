import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactionStore } from '../interaction-store';

const base = { serverId: 's1', channelId: 'ch1', botId: 'b1', botName: 'Dice', commandName: 'roll' };

beforeEach(() => {
  interactionStore.reset();
});

afterEach(() => {
  vi.useRealTimers();
  interactionStore.reset();
});

describe('interactionStore', () => {
  it('turns a pending row into "did not respond" after 15 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    interactionStore.addPending({ ...base, id: 'i1' });
    const row = interactionStore.getSnapshot().interactions[0]!;
    expect(row).toMatchObject({ status: 'pending', expiresAt: '2026-10-03T10:15:00.000Z' });
    expect(interactionStore.getSnapshot().announcement).toMatchObject({ kind: 'pending', botName: 'Dice' });

    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(interactionStore.getSnapshot().interactions[0]!.status).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(interactionStore.getSnapshot().interactions[0]!.status).toBe('expired');
    expect(interactionStore.getSnapshot().announcement).toMatchObject({ kind: 'expired' });

    // A late answer still clears the row; dismiss works on an expired row.
    interactionStore.dismiss('i1');
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
  });

  it('removes the pending row when the answer arrives, and stops its timer', () => {
    vi.useFakeTimers();
    interactionStore.addPending({ ...base, id: 'i1' });
    interactionStore.markAnswered('i1');
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
    vi.advanceTimersByTime(20 * 60_000);
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
  });

  it('ignores a pending row whose answer already arrived (an answer can beat the 202)', () => {
    interactionStore.markAnswered('i1');
    interactionStore.addPending({ ...base, id: 'i1' });
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
  });

  it('keeps ephemeral answers in memory only, and replaces the pending row', () => {
    interactionStore.addPending({ ...base, id: 'i1' });
    interactionStore.addEphemeral({
      key: 'k1',
      interactionId: 'i1',
      serverId: 's1',
      channelId: 'ch1',
      content: 'You rolled 4',
      createdAt: '2026-10-03T10:00:00.000Z',
    });
    const state = interactionStore.getSnapshot();
    expect(state.interactions).toEqual([]);
    // Bot and command come from the pending row when the event lacks them.
    expect(state.ephemerals).toEqual([
      expect.objectContaining({ key: 'k1', botName: 'Dice', commandName: 'roll', content: 'You rolled 4' }),
    ]);
    interactionStore.addEphemeral({ key: 'k1', interactionId: 'i1', serverId: null, channelId: 'ch1', content: 'dup', createdAt: '' });
    expect(interactionStore.getSnapshot().ephemerals).toHaveLength(1);
    interactionStore.dismiss('k1');
    expect(interactionStore.getSnapshot().ephemerals).toEqual([]);
  });

  it('does not let dismiss remove a row that is still pending', () => {
    interactionStore.addPending({ ...base, id: 'i1' });
    interactionStore.dismiss('i1');
    expect(interactionStore.getSnapshot().interactions).toHaveLength(1);
  });
});
