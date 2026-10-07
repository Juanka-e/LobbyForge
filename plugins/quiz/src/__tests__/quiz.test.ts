import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import {
  QUIZ_STATE_VERSION,
  migrateQuizState,
  quizPlugin,
  quizValidateAction,
  type QuizAction,
  type QuizQuestion,
  type QuizState,
} from '../index';
import { hydrateQuizPackStart } from '../packs/server';
import { toQuizView } from '../view';

const questions: QuizQuestion[] = [
  { id: 'q1', question: '2+2?', options: ['3', '4', '5'], correctIndex: 1, timeLimitSeconds: 20 },
  { id: 'q2', question: 'Capital of TR?', options: ['Istanbul', 'Ankara', 'Izmir'], correctIndex: 1, timeLimitSeconds: 20 },
];

function dispatch(state: QuizState, action: QuizAction): QuizState {
  return quizPlugin.handleAction(null as never, state, action);
}

describe('@lobbyforge/quiz — plugin contract', () => {
  it('runs a whole game through the SDK harness', async () => {
    const harness = createTestHarness<QuizState, QuizAction>({ plugin: quizPlugin, players: ['host', 'p1'] });
    await harness.startGame();
    // The creator (the harness's first player) hosts and plays.
    expect(harness.getState().players.map((p) => p.id)).toEqual(['host']);
    await harness.performAction('p1', { type: 'join', playerId: 'p1' });
    await harness.performAction('host', { type: 'start', source: 'custom', questions, shuffle: false, questionCount: 5 });
    expect(harness.getState().phase).toBe('playing');

    await harness.performAction('host', { type: 'answer', playerId: 'host', index: 1 });
    await harness.performAction('p1', { type: 'answer', playerId: 'p1', index: 0 });
    expect(harness.getState().phase).toBe('reveal');
    expect(harness.getState().reveal?.counts).toEqual([1, 1, 0]);

    await harness.performAction('host', { type: 'next' });
    await harness.performAction('host', { type: 'reveal' });
    await harness.performAction('host', { type: 'next' });
    const final = harness.getState();
    expect(final.phase).toBe('ended');
    expect(final.endReason).toBe('completed');
    expect(final.questionsRevealed).toBe(2);
    expect(final.players.find((p) => p.id === 'host')!.score).toBeGreaterThan(final.players.find((p) => p.id === 'p1')!.score);
  });

  it('declares who may do what, injecting the actor for player actions', () => {
    expect(quizPlugin.actionPolicies).toEqual({
      start: { role: 'host' },
      'set-questions': { role: 'host' },
      reveal: { role: 'host' },
      next: { role: 'host' },
      end: { role: 'host' },
      'play-again': { role: 'host' },
      // Joining names the player on the public roster; answering never does.
      join: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
      // Playing needs the voice room; leaving does not.
      leave: { role: 'member', actorFields: ['playerId'], allowOutsideVoice: true },
      answer: { role: 'member', actorFields: ['playerId'] },
      'time-up': { role: 'member' },
    });
    // A finished quiz accepts "play again" and nothing else.
    expect(quizPlugin.restartActions).toEqual(['play-again']);
    expect(quizPlugin.manifest.catalog?.requiresVoiceRoom).toBe(true);
  });

  it('ships English and Turkish, with the catalogue summary from the locale files', () => {
    expect(quizPlugin.manifest.locales).toEqual(['en', 'tr']);
    expect(quizPlugin.manifest.catalog?.summary).toMatch(/trivia/i);
    expect(quizPlugin.manifest.id).toBe('quiz');
  });

  it('renderClient returns an element and never runs the panel at call time', () => {
    const props = {
      state: toQuizView(quizPlugin.createInitialState(null as never)),
      dispatch: () => {},
      actorUserId: 'u1',
      hostUserId: 'u1',
      players: [{ userId: 'u1', name: 'Host' }],
    };
    expect(() => quizPlugin.renderClient(props)).not.toThrow();
    expect(isValidElement(quizPlugin.renderClient(props))).toBe(true);
  });
});

describe('validateAction — the raw HTTP payload guard', () => {
  it('answers need a non-negative integer index and the injected playerId', () => {
    expect(quizValidateAction({ type: 'answer', index: 1, playerId: 'p1' })).toBeNull();
    expect(quizValidateAction({ type: 'answer', index: 1 })).toMatch(/playerId/);
    expect(quizValidateAction({ type: 'answer', index: -1, playerId: 'p1' })).toMatch(/index/);
    expect(quizValidateAction({ type: 'answer', index: 1.5, playerId: 'p1' })).toMatch(/index/);
    expect(quizValidateAction({ type: 'answer', index: '1', playerId: 'p1' })).toMatch(/index/);
  });

  it('play-again needs nothing but its type', () => {
    expect(quizValidateAction({ type: 'play-again' })).toBeNull();
  });

  it('start: a known pack, or a valid custom list; settings from the allowed sets', () => {
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'tr' })).toBeNull();
    expect(
      quizValidateAction({ type: 'start', source: 'pack', packId: 'science', language: 'en', questionCount: 15, secondsPerQuestion: 30, shuffle: false })
    ).toBeNull();
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'de' })).toMatch(/Unknown question pack/);
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general' })).toMatch(/language/);
    expect(quizValidateAction({ type: 'start', source: 'deck' })).toMatch(/source/);
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'en', questionCount: 7 })).toMatch(/questionCount/);
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'en', secondsPerQuestion: 5 })).toMatch(/secondsPerQuestion/);
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'en', shuffle: 'yes' })).toMatch(/shuffle/);
    expect(quizValidateAction({ type: 'start', source: 'custom', questions })).toBeNull();
    expect(quizValidateAction({ type: 'start', source: 'custom', questions: [] })).toMatch(/at least one/);
    // A pack start from the client has no questions; junk in that slot is refused at the boundary.
    expect(quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'en', questions: 'x' })).toMatch(/array/);
    expect(
      quizValidateAction({ type: 'start', source: 'pack', packId: 'general', language: 'en', questions: [{ question: '?', options: ['a'], correctIndex: 0 }] })
    ).toMatch(/options/);
  });

  it('a pack game plays only what the host injected', () => {
    const lobby = quizPlugin.handleAction(null as never, quizPlugin.createInitialState({ actorUserId: 'host' } as never), {
      type: 'join',
      playerId: 'p1',
    });
    // Straight from a client, a pack start carries no questions: nothing to play.
    const raw: QuizAction = { type: 'start', source: 'pack', packId: 'science', language: 'en' };
    expect(dispatch(lobby, raw)).toBe(lobby);
    // Hydrated by the host (see packs/server.ts), it starts.
    const hydrated = hydrateQuizPackStart(raw as unknown as Record<string, unknown>);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const started = dispatch(lobby, hydrated.action as unknown as QuizAction);
    expect(started.phase).toBe('playing');
    expect(started.deck.every((q) => q.id.startsWith('sci-en-'))).toBe(true);
  });

  it('questions: correctIndex must point at an option; options must differ', () => {
    expect(quizValidateAction({ type: 'set-questions', questions })).toBeNull();
    expect(quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], correctIndex: 5 }] })).toMatch(/correctIndex/);
    expect(quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], options: ['only'] }] })).toMatch(/options/);
    expect(quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], options: ['Yes', ' yes '] }] })).toMatch(/different/);
    expect(quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], question: '  ' }] })).toMatch(/question/);
    expect(quizValidateAction({ type: 'set-questions', questions: [{ ...questions[0], timeLimitSeconds: 0 }] })).toMatch(/timeLimitSeconds/);
    expect(quizValidateAction({ type: 'set-questions', questions: 'nope' })).toMatch(/array/);
    expect(quizValidateAction({ type: 'set-questions', questions: Array.from({ length: 51 }, () => questions[0]) })).toMatch(/at most 50/);
  });

  it('join / leave need the injected playerId', () => {
    expect(quizValidateAction({ type: 'join', playerId: 'p1' })).toBeNull();
    expect(quizValidateAction({ type: 'join' })).toMatch(/playerId/);
    expect(quizValidateAction({ type: 'leave', playerId: 'p1' })).toBeNull();
    expect(quizValidateAction({ type: 'leave' })).toMatch(/playerId/);
  });

  it('a joining player is named by the host roster, never by the payload', () => {
    const ctx = {
      players: { get: (id: string) => (id === 'p1' ? { id, name: 'Kaya' } : id === 'p2' ? { id, name: id } : undefined) },
    };
    let state = quizPlugin.createInitialState({ actorUserId: 'host' } as never);
    state = quizPlugin.handleAction(ctx as never, state, { type: 'join', playerId: 'p1', name: 'Mira' } as unknown as QuizAction);
    // A host "name" that is just the id means it has none.
    state = quizPlugin.handleAction(ctx as never, state, { type: 'join', playerId: 'p2' });
    state = quizPlugin.handleAction(null as never, state, { type: 'join', playerId: 'p3' });
    expect(state.players.map((p) => [p.id, p.name])).toEqual([
      ['host', null],
      ['p1', 'Kaya'],
      ['p2', null],
      ['p3', null],
    ]);
  });

  it('bare actions pass; anything else is rejected', () => {
    for (const type of ['time-up', 'reveal', 'next', 'end']) expect(quizValidateAction({ type })).toBeNull();
    expect(quizValidateAction({ type: 'hack' })).toMatch(/Unknown/);
    expect(quizValidateAction(null)).toMatch(/object/);
    expect(quizValidateAction([])).toMatch(/object/);
  });

  it('the reducer ignores anything validateAction rejects (defense in depth)', () => {
    const state = quizPlugin.createInitialState({ actorUserId: 'host' } as never);
    expect(dispatch(state, { type: 'answer', index: 1 } as unknown as QuizAction)).toBe(state);
    expect(dispatch(state, { type: 'start', source: 'pack', packId: 'nope', language: 'en' })).toBe(state);
    expect(dispatch(state, { type: 'bogus' } as unknown as QuizAction)).toBe(state);
  });
});

describe('migrateState — sessions written by older builds', () => {
  const legacy = (overrides: Record<string, unknown> = {}) => ({
    questions,
    currentIndex: 0,
    score: 2,
    correctCount: 2,
    totalAnswered: 3,
    finished: false,
    ...overrides,
  });

  it('upgrades an unversioned game in progress: deck, players, no timer', () => {
    const migrated = migrateQuizState(
      legacy({ phase: 'playing', currentAnswers: { alice: 1 }, playerScores: { alice: 2, bob: 1 } })
    );
    expect(migrated.version).toBe(QUIZ_STATE_VERSION);
    expect(migrated.phase).toBe('playing');
    expect(migrated.deck.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(migrated.current).toEqual({ index: 0, question: '2+2?', options: ['3', '4', '5'] });
    expect(migrated.current).not.toHaveProperty('correctIndex');
    expect(migrated.deadline).toBeNull();
    expect(migrated.answers).toEqual({ alice: { choice: 1, at: 0 } });
    expect(migrated.players.map((p) => [p.id, p.score, p.correct])).toEqual([
      ['alice', 1_000, 2],
      ['bob', 500, 1],
    ]);
    expect(migrated.settings).toMatchObject({ source: 'custom', shuffle: false, secondsPerQuestion: 20 });
  });

  it('a migrated legacy game can be finished by the host', () => {
    let state = migrateQuizState(legacy({ phase: 'playing', currentAnswers: { alice: 1 }, playerScores: { alice: 0 } }));
    state = dispatch(state, { type: 'reveal' });
    expect(state.phase).toBe('reveal');
    expect(state.players.find((p) => p.id === 'alice')).toMatchObject({ score: 500, lastResult: 'correct' });
    state = dispatch(state, { type: 'next' });
    state = dispatch(state, { type: 'reveal' });
    state = dispatch(state, { type: 'next' });
    expect(state.phase).toBe('ended');
  });

  it('maps every legacy phase', () => {
    expect(migrateQuizState(legacy()).phase).toBe('playing');
    expect(migrateQuizState(legacy({ finished: true })).phase).toBe('ended');
    expect(migrateQuizState({}).phase).toBe('lobby');
    expect(migrateQuizState(legacy({ questions: [] })).phase).toBe('lobby');
    const revealed = migrateQuizState(legacy({ phase: 'reveal', currentAnswers: { a: 1, b: 0, c: 1 } }));
    expect(revealed.reveal).toEqual({ index: 0, correctIndex: 1, counts: [1, 2, 0], answered: 3, correct: 2 });
    expect(revealed.questionsRevealed).toBe(1);
    expect(migrateQuizState(legacy({ currentIndex: 5, phase: 'playing' })).phase).toBe('ended');
  });

  it('is idempotent, and a current state comes back untouched', () => {
    const migrated = migrateQuizState(legacy({ phase: 'reveal', currentAnswers: { a: 1 } }));
    expect(migrateQuizState(migrated)).toBe(migrated);
    expect(migrateQuizState(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
    const fresh = quizPlugin.createInitialState({ actorUserId: 'host' } as never);
    expect(migrateQuizState(fresh)).toBe(fresh);
  });

  it('never crashes on junk', () => {
    for (const junk of [null, undefined, 42, 'x', [], { version: 2 }, { version: 2, phase: 'weird', players: 'no' }]) {
      const state = migrateQuizState(junk);
      expect(['lobby', 'playing', 'reveal', 'ended']).toContain(state.phase);
      expect(Array.isArray(state.players)).toBe(true);
      expect(Array.isArray(state.deck)).toBe(true);
    }
  });
});

describe('toQuizView — what the panel makes of what it is handed', () => {
  it('fills in a projected state and refuses to show a question phase with no question', () => {
    expect(toQuizView(null).phase).toBe('lobby');
    const view = toQuizView({ phase: 'playing', current: null, players: [{ id: 'a' }, { nope: true }] });
    expect(view.phase).toBe('lobby');
    expect(view.players.map((p) => p.id)).toEqual(['a']);
    expect(view.myAnswer).toBeNull();
    expect(toQuizView({ myAnswer: 2 }).myAnswer).toBe(2);
    expect(toQuizView({ myAnswer: -1 }).myAnswer).toBeNull();
  });
});
