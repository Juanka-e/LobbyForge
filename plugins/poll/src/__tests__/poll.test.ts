import { describe, expect, it } from 'vitest';
import {
  pollPlugin,
  pollTally,
  pollLeader,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type PollState,
} from '../index.js';

/** Direct reducer tests — the pure State → Action → State contract. */
function initial(): PollState {
  return pollPlugin.createInitialState(null as never);
}

function open(state: PollState, host = 'host-1'): PollState {
  return pollPlugin.handleAction(
    null as never,
    state,
    { type: 'open-poll', hostId: host, question: 'Next game?', options: ['Hushle', 'Quiz', 'Chill'] }
  );
}

function vote(state: PollState, playerId: string, optionId: string): PollState {
  return pollPlugin.handleAction(null as never, state, { type: 'vote', playerId, optionId });
}

describe('poll plugin — lifecycle', () => {
  it('opens a poll with sanitized options and resets the ballot box', () => {
    const state = open(initial());
    expect(state.phase).toBe('open');
    expect(state.question).toBe('Next game?');
    expect(state.options.map((o) => o.text)).toEqual(['Hushle', 'Quiz', 'Chill']);
    expect(state.ballotBox).toEqual([]);
  });

  it('rejects too few / too many options and empty questions', () => {
    const s0 = initial();
    expect(
      pollPlugin.handleAction(null as never, s0, {
        type: 'open-poll', hostId: 'h', question: 'Q', options: ['only-one'],
      }).phase
    ).toBe('idle');
    expect(
      pollPlugin.handleAction(null as never, s0, {
        type: 'open-poll',
        hostId: 'h',
        question: 'Q',
        options: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`),
      }).phase
    ).toBe('idle');
    expect(
      pollPlugin.handleAction(null as never, s0, {
        type: 'open-poll', hostId: 'h', question: '   ', options: ['a', 'b'],
      }).phase
    ).toBe('idle');
    expect(POLL_MIN_OPTIONS).toBe(2);
  });
});

describe('poll plugin — one vote per player (state-enforced)', () => {
  it('counts a vote once and refuses the second ballot', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = vote(state, 'p2', 'opt-1');
    state = vote(state, 'p1', 'opt-2'); // double vote — silently ignored
    expect(pollTally(state)).toEqual([
      { optionId: 'opt-1', votes: 2 },
      { optionId: 'opt-2', votes: 0 },
      { optionId: 'opt-3', votes: 0 },
    ]);
  });

  it('refuses votes for unknown options and outside the open phase', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-99');
    expect(state.ballotBox).toEqual([]);
    let closed = pollPlugin.handleAction(null as never, state, { type: 'close-poll', hostId: 'host-1' });
    closed = vote(closed, 'p1', 'opt-1');
    expect(closed.ballotBox).toEqual([]);
  });
});

describe('poll plugin — close / reopen / clear', () => {
  it('closing freezes voting and stamps closedAt', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-2');
    state = pollPlugin.handleAction(null as never, state, { type: 'close-poll', hostId: 'host-1' });
    expect(state.phase).toBe('closed');
    expect(state.closedAt).toBeTruthy();
    expect(pollTally(state)[1].votes).toBe(1);
  });

  it('reopen keeps the ballot box — no double voting across the gap', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = pollPlugin.handleAction(null as never, state, { type: 'close-poll', hostId: 'host-1' });
    state = pollPlugin.handleAction(null as never, state, { type: 'reopen-poll', hostId: 'host-1' });
    expect(state.phase).toBe('open');
    state = vote(state, 'p1', 'opt-2'); // already voted — ignored
    expect(pollTally(state)[0].votes).toBe(1);
    expect(pollTally(state)[1].votes).toBe(0);
    state = vote(state, 'p9', 'opt-2'); // new voter may join
    expect(pollTally(state)[1].votes).toBe(1);
  });

  it('clear returns to the pristine idle state', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = pollPlugin.handleAction(null as never, state, { type: 'clear-poll', hostId: 'host-1' });
    expect(state).toEqual(initial());
  });
});

describe('poll plugin — tally helpers', () => {
  it('reports the leader when decisive and null on ties/empty', () => {
    let state = open(initial());
    expect(pollLeader(state)).toBeNull(); // no votes
    state = vote(state, 'p1', 'opt-3');
    state = vote(state, 'p2', 'opt-3');
    state = vote(state, 'p3', 'opt-1');
    expect(pollLeader(state)).toBe('opt-3');
    state = vote(state, 'p4', 'opt-1');
    expect(pollLeader(state)).toBeNull(); // 2-2 tie
  });
});

describe('poll plugin — manifest + policies', () => {
  it('declares host-only lifecycle actions and member votes bound to actor fields', () => {
    expect(pollPlugin.manifest.id).toBe('poll');
    expect(pollPlugin.actionPolicies?.['open-poll']).toEqual({ role: 'host', actorFields: ['hostId'] });
    expect(pollPlugin.actionPolicies?.vote).toEqual({ role: 'member', actorFields: ['playerId'] });
    
  });
});
