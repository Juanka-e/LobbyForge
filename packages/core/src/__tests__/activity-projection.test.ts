/**
 * beta-review: canonical projector rules for the leaks found in the
 * beta readiness review (S11 poll ballots, Hushle card ids, Quiz
 * answers). The web app re-exports this function and its own suite
 * (apps/web/lib/__tests__/activity-projection.test.ts) pins the older
 * Hushle / Quiz secrets.
 */
import { describe, expect, it } from 'vitest';
import { projectActivityState } from '../activity-projection.js';

type Rec = Record<string, unknown>;

describe('projectActivityState — poll (S11 anonymous ballots)', () => {
  const pollState = (): Rec => ({
    question: 'Next game?',
    phase: 'open',
    hostId: 'host',
    options: [
      { id: 'opt-1', text: 'Hushle', votes: 1 },
      { id: 'opt-2', text: 'Quiz', votes: 1 },
    ],
    ballotBox: ['alice', 'bob'],
    createdAt: null,
    closedAt: null,
  });

  it('never exposes WHO voted — only the turnout', () => {
    for (const viewer of ['alice', 'bob', 'carol', 'host', undefined]) {
      const out = projectActivityState(pollState(), 'poll', viewer) as Rec;
      expect(out.ballotBox, `viewer=${viewer}`).toBeUndefined();
      expect(out.ballotCount).toBe(2);
      const json = JSON.stringify(out);
      expect(json).not.toContain('alice');
      expect(json).not.toContain('bob');
    }
  });

  it('tells each viewer whether THEY voted', () => {
    expect((projectActivityState(pollState(), 'poll', 'alice') as Rec).hasVoted).toBe(true);
    expect((projectActivityState(pollState(), 'poll', 'carol') as Rec).hasVoted).toBe(false);
    expect((projectActivityState(pollState(), 'poll', undefined) as Rec).hasVoted).toBe(false);
  });

  it('keeps the public tally and does not mutate the canonical state', () => {
    const state = pollState();
    const out = projectActivityState(state, 'poll', 'alice') as Rec;
    expect(out.options).toEqual(state.options);
    expect(state.ballotBox).toEqual(['alice', 'bob']);
  });

  it('handles a missing / malformed ballot box', () => {
    const out = projectActivityState({ phase: 'idle', options: [] }, 'poll', 'alice') as Rec;
    expect(out.ballotCount).toBe(0);
    expect(out.hasVoted).toBe(false);
  });
});

describe('projectActivityState — hushle card ids', () => {
  const hushle = (): Rec => ({
    phase: 'playing',
    currentTeamId: 'team-a',
    currentExplainerId: 'p1',
    currentCard: { id: 'db-card-42', word: 'apple', forbiddenWords: ['fruit'], difficulty: 'easy' },
    deck: [
      { id: 'db-card-41', word: 'train', forbiddenWords: ['rail'], difficulty: 'easy' },
      { id: 'db-card-42', word: 'apple', forbiddenWords: ['fruit'], difficulty: 'easy' },
      { id: 'db-card-43', word: 'volcano', forbiddenWords: ['lava'], difficulty: 'hard' },
    ],
    usedCardIds: ['db-card-41', 'db-card-42'],
    teams: [
      { id: 'team-a', playerIds: ['p1', 'p2'] },
      { id: 'team-b', playerIds: ['p3'] },
    ],
  });

  it('a guesser sees NO card id anywhere (usedCardIds projected to a count)', () => {
    const out = projectActivityState(hushle(), 'hushle', 'p2') as Rec;
    expect(out.currentCard).toBeNull();
    expect(out.usedCardIds).toBeUndefined();
    expect(out.usedCardCount).toBe(2);
    expect(JSON.stringify(out)).not.toContain('db-card');
  });

  it('usedCardIds are dropped for every viewer; counts stay correct', () => {
    for (const viewer of ['p1', 'p2', 'p3', 'spectator', undefined]) {
      const out = projectActivityState(hushle(), 'hushle', viewer) as Rec;
      expect(out.usedCardIds, `viewer=${viewer}`).toBeUndefined();
      expect(out.deckSize).toBe(3);
      expect(out.cardsRemaining).toBe(1);
    }
  });

  it('authorized viewers (explainer / opponents) keep the card they already see', () => {
    for (const viewer of ['p1', 'p3']) {
      const out = projectActivityState(hushle(), 'hushle', viewer) as Rec;
      expect(out.currentCard).toMatchObject({ word: 'apple' });
    }
  });
});

describe('projectActivityState — quiz answers', () => {
  const quiz = (phase: string): Rec => ({
    phase,
    currentIndex: 0,
    questions: [{ id: 'q1', question: '2+2?', options: ['3', '4'], correctIndex: 1 }],
    currentAnswers: { alice: 1, bob: 0 },
    playerScores: {},
  });

  it('while playing, a viewer only sees their own locked answer', () => {
    const out = projectActivityState(quiz('playing'), 'quiz', 'alice') as Rec;
    expect(out.currentAnswers).toEqual({ alice: 1 });
    expect(out.answeredCount).toBe(2);
    const spectator = projectActivityState(quiz('playing'), 'quiz', 'carol') as Rec;
    expect(spectator.currentAnswers).toEqual({});
    expect((spectator.questions as Rec[])[0]!.correctIndex).toBeUndefined();
  });

  it('at reveal every answer and the correct index are public', () => {
    const out = projectActivityState(quiz('reveal'), 'quiz', 'carol') as Rec;
    expect(out.currentAnswers).toEqual({ alice: 1, bob: 0 });
    expect((out.questions as Rec[])[0]!.correctIndex).toBe(1);
  });
});
