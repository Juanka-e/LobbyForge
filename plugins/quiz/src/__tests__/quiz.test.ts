import { describe, it, expect } from 'vitest';
import {
  migrateQuizState,
  quizPlugin,
  quizValidateAction,
  type QuizAction,
  type QuizState,
  type QuizQuestion,
} from '../index.js';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

const questions: QuizQuestion[] = [
  { id: 'q1', question: '2+2?', options: ['3', '4', '5'], correctIndex: 1, timeLimitSeconds: 20 },
  { id: 'q2', question: 'Capital of TR?', options: ['Istanbul', 'Ankara', 'Izmir'], correctIndex: 1, timeLimitSeconds: 20 },
];

function dispatch(state: QuizState, action: QuizAction): QuizState {
  return quizPlugin.handleAction(null as never, state, action);
}

function started(): QuizState {
  return dispatch(quizPlugin.createInitialState(null as never), { type: 'set-questions', questions });
}

describe('@lobbyforge/quiz', () => {
  it('scores at reveal and progresses', async () => {
    const harness = createTestHarness<QuizState, QuizAction>({
      plugin: quizPlugin,
      players: ['p1'],
    });

    await harness.startGame();
    await harness.performAction('p1', { type: 'set-questions', questions });
    expect(harness.getState().questions).toHaveLength(2);
    expect(harness.getState().phase).toBe('playing');

    await harness.performAction('p1', { type: 'answer', index: 1, playerId: 'p1' });
    // beta-review: nothing is scored before the reveal.
    expect(harness.getState().correctCount).toBe(0);
    expect(harness.getState().score).toBe(0);

    await harness.performAction('p1', { type: 'reveal' });
    expect(harness.getState().phase).toBe('reveal');
    expect(harness.getState().correctCount).toBe(1);
    expect(harness.getState().score).toBe(1);
    expect(harness.getState().playerScores).toEqual({ p1: 1 });

    await harness.performAction('p1', { type: 'next' });
    expect(harness.getState().currentIndex).toBe(1);
    expect(harness.getState().finished).toBe(false);
    expect(harness.getState().currentAnswers).toEqual({});

    await harness.performAction('p1', { type: 'next' });
    expect(harness.getState().finished).toBe(true);
    expect(harness.getState().phase).toBe('ended');
  });
});

describe('quiz — beta-review answer probing', () => {
  it('locks ONE answer per player per question (no retries)', () => {
    let state = started();
    state = dispatch(state, { type: 'answer', index: 0, playerId: 'p1' }); // wrong
    state = dispatch(state, { type: 'answer', index: 1, playerId: 'p1' }); // retry ignored
    state = dispatch(state, { type: 'answer', index: 2, playerId: 'p1' }); // retry ignored
    expect(state.currentAnswers).toEqual({ p1: 0 });
    state = dispatch(state, { type: 'reveal' });
    expect(state.playerScores).toEqual({});
    expect(state.correctCount).toBe(0);
  });

  it('the score never moves while answering, so it cannot be probed', () => {
    let state = started();
    const before = { score: state.score, correctCount: state.correctCount, playerScores: state.playerScores };
    for (const [i, player] of ['p1', 'p2', 'p3'].entries()) {
      state = dispatch(state, { type: 'answer', index: i, playerId: player });
      expect({ score: state.score, correctCount: state.correctCount, playerScores: state.playerScores }).toEqual(before);
    }
    state = dispatch(state, { type: 'reveal' });
    expect(state.playerScores).toEqual({ p2: 1 });
    expect(state.totalAnswered).toBe(3);
  });

  it('rejects answers outside the playing phase and out-of-range indexes', () => {
    let state = started();
    state = dispatch(state, { type: 'answer', index: 9, playerId: 'p1' });
    expect(state.currentAnswers).toEqual({});
    state = dispatch(state, { type: 'reveal' });
    state = dispatch(state, { type: 'answer', index: 1, playerId: 'late' });
    expect(state.currentAnswers).toEqual({});
  });

  it('skipping the reveal with next still scores the locked answers', () => {
    let state = started();
    state = dispatch(state, { type: 'answer', index: 1, playerId: 'p1' });
    state = dispatch(state, { type: 'next' });
    expect(state.playerScores).toEqual({ p1: 1 });
    expect(state.currentIndex).toBe(1);
    expect(state.phase).toBe('playing');
  });

  it('answer injects the actor server-side (actorFields) and validates the payload', () => {
    expect(quizPlugin.actionPolicies?.answer).toEqual({ role: 'member', actorFields: ['playerId'] });
    expect(quizValidateAction({ type: 'answer', index: 1, playerId: 'p1' })).toBeNull();
    expect(quizValidateAction({ type: 'answer', index: 1 })).toMatch(/playerId/);
    expect(quizValidateAction({ type: 'answer', index: -1, playerId: 'p1' })).toMatch(/index/);
    expect(quizValidateAction({ type: 'answer', index: 1.5, playerId: 'p1' })).toMatch(/index/);
    expect(quizValidateAction({ type: 'answer', index: '1', playerId: 'p1' })).toMatch(/index/);
    expect(quizValidateAction({ type: 'hack' })).toMatch(/Unknown/);
    expect(quizValidateAction(null)).toMatch(/object/);
  });

  it('validates set-questions (correctIndex must point at an option)', () => {
    expect(quizValidateAction({ type: 'set-questions', questions })).toBeNull();
    expect(
      quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], correctIndex: 5 }] })
    ).toMatch(/correctIndex/);
    expect(
      quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], options: ['only'] }] })
    ).toMatch(/options/);
    expect(quizValidateAction({ type: 'set-questions', questions: 'nope' })).toMatch(/array/);
  });

  it('the reducer ignores anything validateAction rejects (defense in depth)', () => {
    const state = started();
    const next = dispatch(state, { type: 'answer', index: 1 } as unknown as QuizAction);
    expect(next).toBe(state);
  });

  it('migrates legacy sessions without phase / per-player fields', () => {
    const legacy = {
      questions,
      currentIndex: 0,
      score: 2,
      correctCount: 2,
      totalAnswered: 3,
      finished: false,
    };
    const migrated = migrateQuizState(legacy);
    expect(migrated.phase).toBe('playing');
    expect(migrated.currentAnswers).toEqual({});
    expect(migrated.playerScores).toEqual({});
    expect(migrated.score).toBe(2);
    expect(migrateQuizState({ ...legacy, finished: true }).phase).toBe('ended');
    expect(migrateQuizState({}).phase).toBe('lobby');
    // Idempotent.
    expect(migrateQuizState(migrated)).toEqual(migrated);
  });
});
