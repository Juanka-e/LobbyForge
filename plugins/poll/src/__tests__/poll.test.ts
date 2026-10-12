import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  migratePollState,
  pollPlugin,
  pollValidateAction,
  pollTally,
  pollLeader,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type PollAction,
  type PollState,
} from '../index.js';

/** Direct reducer tests — the pure State → Action → State contract. */
function initial(): PollState {
  return pollPlugin.createInitialState(null as never);
}

function dispatch(state: PollState, action: PollAction): PollState {
  return pollPlugin.handleAction(null as never, state, action);
}

function open(state: PollState, host = 'host-1'): PollState {
  return dispatch(state, {
    type: 'open-poll', hostId: host, question: 'Next game?', options: ['Hushle', 'Quiz', 'Chill'],
  });
}

function vote(state: PollState, playerId: string, optionId: string): PollState {
  return dispatch(state, { type: 'vote', playerId, optionId });
}

describe('poll plugin — lifecycle', () => {
  it('opens a poll with sanitized options and resets the ballot box', () => {
    const state = open(initial());
    expect(state.phase).toBe('open');
    expect(state.question).toBe('Next game?');
    expect(state.options.map((o) => o.text)).toEqual(['Hushle', 'Quiz', 'Chill']);
    expect(state.options.every((o) => o.votes === 0)).toBe(true);
    expect(state.ballotBox).toEqual([]);
  });

  it('rejects too few / too many options and empty questions', () => {
    const s0 = initial();
    expect(dispatch(s0, { type: 'open-poll', hostId: 'h', question: 'Q', options: ['only-one'] }).phase).toBe('idle');
    expect(
      dispatch(s0, {
        type: 'open-poll', hostId: 'h', question: 'Q',
        options: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`),
      }).phase
    ).toBe('idle');
    expect(dispatch(s0, { type: 'open-poll', hostId: 'h', question: '   ', options: ['a', 'b'] }).phase).toBe('idle');
    expect(POLL_MIN_OPTIONS).toBe(2);
  });
});

describe('poll plugin — one vote per player, anonymous by construction', () => {
  it('counts ballots once and refuses the second vote', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = vote(state, 'p2', 'opt-1');
    state = vote(state, 'p1', 'opt-2'); // double vote — ignored
    expect(pollTally(state)).toEqual([
      { optionId: 'opt-1', votes: 2 },
      { optionId: 'opt-2', votes: 0 },
      { optionId: 'opt-3', votes: 0 },
    ]);
  });

  it('state contains NO record of who voted for what (privacy by construction)', () => {
    let state = open(initial());
    state = vote(state, 'alice', 'opt-1');
    state = vote(state, 'bob', 'opt-2');
    // Choices are private: the OPTIONS carry counts only — no voter ids.
    expect(JSON.stringify(state.options)).not.toContain('alice');
    expect(JSON.stringify(state.options)).not.toContain('bob');
    // The CANONICAL state keeps the ballot box for one-vote enforcement;
    // beta-review S11: it never reaches viewers — the core projector
    // swaps it for ballotCount/hasVoted (covered in @lobbyforge/core's
    // activity-projection tests).
    expect(state.ballotBox).toEqual(['alice', 'bob']);
    expect(state.options.map((o) => o.votes)).toEqual([1, 1, 0]);
  });

  it('refuses votes for unknown options and outside the open phase', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-99');
    expect(state.ballotBox).toEqual([]);
    let closed = dispatch(state, { type: 'close-poll', hostId: 'host-1' });
    closed = vote(closed, 'p1', 'opt-1');
    expect(closed.ballotBox).toEqual([]);
  });
});

describe('poll plugin — close / reopen / clear', () => {
  it('closing freezes voting and stamps closedAt', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-2');
    state = dispatch(state, { type: 'close-poll', hostId: 'host-1' });
    expect(state.phase).toBe('closed');
    expect(state.closedAt).toBeTruthy();
    expect(pollTally(state)[1].votes).toBe(1);
  });

  it('reopen keeps the ballot box — no double voting across the gap', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = dispatch(state, { type: 'close-poll', hostId: 'host-1' });
    state = dispatch(state, { type: 'reopen-poll', hostId: 'host-1' });
    expect(state.phase).toBe('open');
    state = vote(state, 'p1', 'opt-2'); // already voted — ignored
    expect(pollTally(state)[0].votes).toBe(1);
    expect(pollTally(state)[1].votes).toBe(0);
    state = vote(state, 'p9', 'opt-2'); // new voter may join
    expect(pollTally(state)[1].votes).toBe(1);
  });

  it('clear returns to the pristine idle state — keeping the poll number', () => {
    let state = open(initial());
    state = vote(state, 'p1', 'opt-1');
    state = dispatch(state, { type: 'clear-poll', hostId: 'host-1' });
    expect(state).toEqual({ ...initial(), pollId: 1 });
  });
});

describe('poll plugin — stale votes (B-06): a vote names its poll', () => {
  const voteFor = (state: PollState, playerId: string, optionId: string, pollId: number | null): PollState =>
    dispatch(state, { type: 'vote', playerId, optionId, pollId });

  it('numbers every poll it opens; close and reopen keep the number, clear keeps it for the next', () => {
    const s0 = initial();
    expect(s0.pollId).toBe(0);
    const first = open(s0);
    expect(first.pollId).toBe(1);
    const closed = dispatch(first, { type: 'close-poll', hostId: 'host-1' });
    expect(dispatch(closed, { type: 'reopen-poll', hostId: 'host-1' }).pollId).toBe(1);
    const cleared = dispatch(closed, { type: 'clear-poll', hostId: 'host-1' });
    expect(cleared.pollId).toBe(1);
    expect(open(cleared).pollId).toBe(2);
    // Opening over a running poll replaces it — a new poll, a new number.
    expect(open(first).pollId).toBe(2);
  });

  it('a vote naming the open poll counts; one without a poll number counts as before', () => {
    let state = open(initial());
    state = voteFor(state, 'p1', 'opt-1', state.pollId);
    state = vote(state, 'p2', 'opt-2');
    state = voteFor(state, 'p3', 'opt-2', null);
    expect(pollTally(state).map((t) => t.votes)).toEqual([1, 2, 0]);
    expect(state.ballotBox).toEqual(['p1', 'p2', 'p3']);
  });

  it('a vote cast before the host cleared and reopened is ignored — never counted on the new poll', () => {
    const before = open(initial());
    const castFor = before.pollId;
    const cleared = dispatch(before, { type: 'clear-poll', hostId: 'host-1' });
    const reopened = dispatch(cleared, {
      type: 'open-poll', hostId: 'host-1', question: 'Snacks?', options: ['Chips', 'Fruit'],
    });
    // `opt-1` exists on the new poll too; the vote still names the old one.
    const late = voteFor(reopened, 'p1', 'opt-1', castFor);
    expect(late).toBe(reopened);
    expect(late.ballotBox).toEqual([]);
    // p1 may still vote on the new poll.
    expect(voteFor(reopened, 'p1', 'opt-2', reopened.pollId).ballotBox).toEqual(['p1']);
  });

  it('a vote for the same poll across a close and reopen still counts', () => {
    const first = open(initial());
    const castFor = first.pollId;
    let state = dispatch(first, { type: 'close-poll', hostId: 'host-1' });
    state = dispatch(state, { type: 'reopen-poll', hostId: 'host-1' });
    state = voteFor(state, 'p1', 'opt-3', castFor);
    expect(pollTally(state)[2]!.votes).toBe(1);
  });

  it('a vote naming a poll that is not on — older or newer — is ignored', () => {
    const state = open(open(initial()));
    expect(voteFor(state, 'p1', 'opt-1', 1)).toBe(state);
    expect(voteFor(state, 'p1', 'opt-1', 3)).toBe(state);
  });

  it("validateAction: a vote's pollId, when present, is a non-negative integer", () => {
    expect(pollValidateAction({ type: 'vote', playerId: 'p', optionId: 'opt-1', pollId: 0 })).toBeNull();
    expect(pollValidateAction({ type: 'vote', playerId: 'p', optionId: 'opt-1', pollId: 12 })).toBeNull();
    expect(pollValidateAction({ type: 'vote', playerId: 'p', optionId: 'opt-1', pollId: null })).toBeNull();
    for (const pollId of [-1, 1.5, '1', Number.NaN, {}]) {
      expect(pollValidateAction({ type: 'vote', playerId: 'p', optionId: 'opt-1', pollId })).toContain('pollId');
    }
    // The reducer ignores such a vote as well (defense in depth).
    const state = open(initial());
    expect(dispatch(state, { type: 'vote', playerId: 'p', optionId: 'opt-1', pollId: '1' } as unknown as PollAction)).toBe(state);
  });
});

describe('poll plugin — state migration', () => {
  it('gives a session written before poll numbers the number 0, the same on every read', () => {
    // An open poll persisted by the previous build: no pollId.
    const legacy = {
      question: 'Next game?',
      options: [{ id: 'opt-1', text: 'Hushle', votes: 1 }, { id: 'opt-2', text: 'Quiz', votes: 0 }],
      phase: 'open',
      hostId: 'host-1',
      ballotBox: ['p1'],
      createdAt: '2026-10-01T10:00:00.000Z',
      closedAt: null,
    };
    const migrated = migratePollState(legacy);
    expect(migrated).toEqual({ ...legacy, pollId: 0 });
    expect(migratePollState(legacy)).toEqual(migrated);
    expect(migratePollState(migrated)).toBe(migrated);
    // A panel that read the migrated state votes for poll 0 and is counted;
    // an old panel that sends no number is counted too.
    const voted = dispatch(migrated, { type: 'vote', playerId: 'p2', optionId: 'opt-2', pollId: migrated.pollId });
    expect(voted.ballotBox).toEqual(['p1', 'p2']);
    expect(vote(voted, 'p3', 'opt-1').ballotBox).toEqual(['p1', 'p2', 'p3']);
    // The next poll gets a number of its own.
    const next = open(dispatch(voted, { type: 'clear-poll', hostId: 'host-1' }));
    expect(next.pollId).toBe(1);
  });

  it("falls back to the pristine state on garbage, and is wired as the plugin's migrateState", () => {
    expect(migratePollState(null)).toEqual(initial());
    expect(migratePollState('nope')).toEqual(initial());
    expect(migratePollState([])).toEqual(initial());
    expect(pollPlugin.migrateState).toBeDefined();
    expect((pollPlugin.migrateState!({ phase: 'idle', options: [] }) as PollState).pollId).toBe(0);
  });
});

describe('poll plugin — tally helpers', () => {
  it('reports the leader when decisive and null on ties/empty', () => {
    let state = open(initial());
    expect(pollLeader(state)).toBeNull();
    state = vote(state, 'p1', 'opt-3');
    state = vote(state, 'p2', 'opt-3');
    state = vote(state, 'p3', 'opt-1');
    expect(pollLeader(state)).toBe('opt-3');
    state = vote(state, 'p4', 'opt-1');
    expect(pollLeader(state)).toBeNull(); // 2-2 tie
  });
});

describe('poll plugin — validateAction (malformed HTTP payloads)', () => {
  it('rejects null question / non-array options before the reducer runs', () => {
    expect(pollValidateAction({ type: 'open-poll', hostId: 'h', question: null, options: ['a', 'b'] })).toContain('question');
    expect(pollValidateAction({ type: 'open-poll', hostId: 'h', question: 'Q', options: {} })).toContain('array');
    expect(pollValidateAction({ type: 'open-poll', hostId: 'h', question: 'Q', options: ['a', 42] })).toContain('strings');
    expect(pollValidateAction({ type: 'open-poll', hostId: 'h', question: 'Q', options: ['a', 'b'] })).toBeNull();
  });

  it('rejects non-string ids, unknown types, and non-object actions', () => {
    expect(pollValidateAction({ type: 'vote', playerId: 7, optionId: 'opt-1' })).toContain('playerId');
    expect(pollValidateAction({ type: 'vote', playerId: 'p', optionId: null })).toContain('optionId');
    expect(pollValidateAction({ type: 'rig-election' })).toContain('Unknown action');
    expect(pollValidateAction('vote')).toContain('object');
    expect(pollValidateAction(null)).toContain('object');
  });

  it('the reducer ignores anything validateAction would reject (defense in depth)', () => {
    const state = open(initial());
    // Simulate a reducer hit with a malformed action anyway.
    const malformed = { type: 'open-poll', hostId: 'h', question: null, options: {} } as unknown as PollAction;
    expect(dispatch(state, malformed)).toBe(state); // unchanged, no throw
    expect(state.question).toBe('Next game?');
  });
});

describe('poll plugin — manifest + policies', () => {
  it('declares host-only lifecycle actions, member votes, honest voice contract', () => {
    expect(pollPlugin.manifest.id).toBe('poll');
    expect(pollPlugin.manifest.catalog?.requiresVoiceRoom).toBe(false);
    expect(pollPlugin.actionPolicies?.['open-poll']).toEqual({ role: 'host', actorFields: ['hostId'] });
    expect(pollPlugin.actionPolicies?.vote).toEqual({ role: 'member', actorFields: ['playerId'] });
    expect(typeof pollPlugin.validateAction).toBe('function');
    // M-poll-ui: the plugin now ships a player screen, so renderClient
    // returns an ELEMENT (see render-client.test.tsx for why it must
    // never CALL the panel).
    expect(isValidElement(pollPlugin.renderClient(null as never))).toBe(true);
  });
});
