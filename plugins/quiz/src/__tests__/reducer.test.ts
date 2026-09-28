import { describe, expect, it } from 'vitest';
import { quizPointsFor, quizReducer, revealQuestion } from '../actions';
import { findQuizPack } from '../packs/server';
import {
  QUIZ_ANSWER_GRACE_MS,
  QUIZ_MAX_PLAYERS,
  createQuizInitialState,
  type QuizAction,
  type QuizState,
} from '../state';
import { Clock, QUESTIONS, T0, customGame, lobbyWith, makeEnv, packStart, run, seeded } from './helpers';

const answer = (playerId: string, index: number): QuizAction => ({ type: 'answer', playerId, index });

describe('lobby: joining and leaving', () => {
  it('starts in the lobby with the host already playing', () => {
    const state = createQuizInitialState('host');
    expect(state.phase).toBe('lobby');
    expect(state.version).toBe(2);
    expect(state.players.map((p) => p.id)).toEqual(['host']);
    expect(state.deck).toEqual([]);
    expect(createQuizInitialState().players).toEqual([]);
  });

  it('adds players once, in join order, named by the HOST (cleaned) — never by the client', () => {
    const names: Record<string, string> = { ben: '  Ben \u202e the\n  Great  ' };
    const env = { ...makeEnv(), nameOf: (id: string) => names[id] ?? null };
    let state = lobbyWith('ana');
    state = quizReducer(state, { type: 'join', playerId: 'ben', name: 'Impostor' } as unknown as QuizAction, env);
    const again = quizReducer(state, { type: 'join', playerId: 'ben' }, env);
    expect(again).toBe(state);
    expect(state.players.map((p) => p.id)).toEqual(['host', 'ana', 'ben']);
    expect(state.players[2]!.name).toBe('Ben the Great');
    expect(state.players[1]!.name).toBeNull();
    expect(state.players.every((p) => p.eligibleFrom === 0 && p.active)).toBe(true);
  });

  it('refreshes a stored name when the host knows a new one, and caps it', () => {
    let name: string | null = 'x'.repeat(80);
    const env = { ...makeEnv(), nameOf: () => name };
    let state = quizReducer(lobbyWith(), { type: 'join', playerId: 'ana' }, env);
    expect(state.players[1]!.name).toBe('x'.repeat(64));
    name = 'Ana';
    state = quizReducer(state, { type: 'join', playerId: 'ana' }, env);
    expect(state.players[1]!.name).toBe('Ana');
    name = null;
    const same = quizReducer(state, { type: 'join', playerId: 'ana' }, env);
    expect(same).toBe(state);
  });

  it('removes a player who leaves before the start', () => {
    const state = quizReducer(lobbyWith('ana', 'ben'), { type: 'leave', playerId: 'ana' });
    expect(state.players.map((p) => p.id)).toEqual(['host', 'ben']);
    expect(quizReducer(state, { type: 'leave', playerId: 'nobody' })).toBe(state);
  });

  it(`refuses more than ${QUIZ_MAX_PLAYERS} active players`, () => {
    let state = createQuizInitialState();
    for (let i = 0; i < QUIZ_MAX_PLAYERS; i += 1) state = quizReducer(state, { type: 'join', playerId: `p${i}` });
    const full = quizReducer(state, { type: 'join', playerId: 'one-too-many' });
    expect(full).toBe(state);
  });
});

describe('start', () => {
  it('builds a pack game: count, timer, open question without its answer', () => {
    const env = makeEnv();
    const state = quizReducer(
      lobbyWith('ana'),
      packStart({ packId: 'general', language: 'en', questionCount: 5, secondsPerQuestion: 10, shuffle: true }),
      env
    );
    expect(state.phase).toBe('playing');
    expect(state.deck).toHaveLength(5);
    expect(state.questionTotal).toBe(5);
    expect(state.settings).toMatchObject({ source: 'pack', packId: 'general', packLanguage: 'en', questionCount: 5, secondsPerQuestion: 10, shuffle: true });
    expect(state.currentIndex).toBe(0);
    expect(state.questionStartedAt).toBe(T0);
    expect(state.deadline).toBe(T0 + 10_000);
    expect(state.current).toEqual({ index: 0, question: state.deck[0]!.question, options: state.deck[0]!.options });
    expect(state.current).not.toHaveProperty('correctIndex');
    expect(state.reveal).toBeNull();
    expect(state.startedAt).toBe(T0);
  });

  it('shuffle off asks the first questions exactly as written', () => {
    const state = customGame(['ana'], makeEnv());
    expect(state.deck.map((q) => q.question)).toEqual(QUESTIONS.map((q) => q.question));
    expect(state.deck.map((q) => q.options)).toEqual(QUESTIONS.map((q) => q.options));
    expect(state.deck.map((q) => q.correctIndex)).toEqual(QUESTIONS.map((q) => q.correctIndex));
    expect(state.deck.map((q) => q.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('shuffle on mixes questions and answers but keeps every right answer right', () => {
    const env = makeEnv(new Clock(), seeded(7));
    const state = quizReducer(
      lobbyWith('ana'),
      packStart({ packId: 'geography', language: 'tr', questionCount: 20, shuffle: true }),
      env
    );
    expect(state.deck).toHaveLength(20);
    expect(new Set(state.deck.map((q) => q.id)).size).toBe(20);
    const pack = findQuizPack('geography', 'tr')!;
    for (const question of state.deck) {
      const original = pack.questions.find((q) => q.id === question.id)!;
      expect([...question.options].sort()).toEqual([...original.options].sort());
      expect(question.options[question.correctIndex]).toBe(original.options[original.correctIndex]);
    }
    // Different seeds, different games.
    const other = quizReducer(
      lobbyWith('ana'),
      packStart({ packId: 'geography', language: 'tr', questionCount: 20, shuffle: true }),
      makeEnv(new Clock(), seeded(8))
    );
    expect(other.deck.map((q) => q.id)).not.toEqual(state.deck.map((q) => q.id));
  });

  it('never asks more questions than the source has', () => {
    const state = quizReducer(
      lobbyWith('ana'),
      { type: 'start', source: 'custom', questions: QUESTIONS, questionCount: 20, shuffle: false },
      makeEnv()
    );
    expect(state.deck).toHaveLength(3);
    expect(state.questionTotal).toBe(3);
    expect(state.settings.questionCount).toBe(20);
  });

  it('uses defaults for missing settings', () => {
    const state = quizReducer(lobbyWith('ana'), packStart({ packId: 'science', language: 'en' }), makeEnv());
    expect(state.settings).toMatchObject({ questionCount: 10, secondsPerQuestion: 20, shuffle: true });
    expect(state.deck).toHaveLength(10);
  });

  it('needs at least one player, a known pack and the lobby', () => {
    const empty = createQuizInitialState();
    const start = packStart({ packId: 'general', language: 'en' });
    expect(quizReducer(empty, start, makeEnv())).toBe(empty);
    const lobby = lobbyWith('ana');
    expect(quizReducer(lobby, { ...start, packId: 'nope' }, makeEnv())).toBe(lobby);
    const playing = quizReducer(lobby, start, makeEnv());
    expect(quizReducer(playing, start, makeEnv())).toBe(playing);
  });

  it('a pack start the host did not hydrate plays nothing (the reducer never looks packs up)', () => {
    const lobby = lobbyWith('ana');
    expect(quizReducer(lobby, { type: 'start', source: 'pack', packId: 'general', language: 'en' }, makeEnv())).toBe(lobby);
    expect(quizReducer(lobby, { type: 'start', source: 'pack', packId: 'general', language: 'en', questions: [] }, makeEnv())).toBe(lobby);
  });

  it('a pack game keeps the pack’s question ids; pasted questions are numbered', () => {
    const state = quizReducer(lobbyWith('ana'), packStart({ packId: 'general', language: 'tr', shuffle: false, questionCount: 5 }), makeEnv());
    expect(state.deck.map((q) => q.id)).toEqual(['gen-tr-01', 'gen-tr-02', 'gen-tr-03', 'gen-tr-04', 'gen-tr-05']);
    expect(state.settings).toMatchObject({ source: 'pack', packId: 'general', packLanguage: 'tr' });
  });

  it('resets every score when a game starts', () => {
    const lobby = lobbyWith('ana');
    const dirty: QuizState = { ...lobby, players: lobby.players.map((p) => ({ ...p, score: 999, streak: 4 })) };
    const started = quizReducer(dirty, { type: 'start', source: 'custom', questions: QUESTIONS }, makeEnv());
    expect(started.players.map((p) => p.id)).toEqual(['host', 'ana']);
    expect(started.players.every((p) => p.score === 0 && p.streak === 0)).toBe(true);
  });

  it('legacy set-questions starts a custom game with every question, in order', () => {
    const env = makeEnv();
    const state = quizReducer(lobbyWith('ana'), { type: 'set-questions', questions: QUESTIONS }, env);
    expect(state.phase).toBe('playing');
    expect(state.settings).toMatchObject({ source: 'custom', shuffle: false, questionCount: 3, secondsPerQuestion: 20 });
    expect(state.deck.map((q) => q.question)).toEqual(QUESTIONS.map((q) => q.question));
  });
});

describe('answering', () => {
  it('locks ONE answer per eligible player and never scores before the reveal', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    env.clock.advance(4_000);
    state = quizReducer(state, answer('ana', 0), env);
    const retried = run(state, [answer('ana', 1), answer('ana', 2)], env);
    expect(retried).toBe(state);
    expect(state.answers).toEqual({ ana: { choice: 0, at: T0 + 4_000 } });
    expect(state.phase).toBe('playing');
    expect(state.players.every((p) => p.score === 0 && p.lastResult === null)).toBe(true);
  });

  it('ignores spectators, unknown options and anything outside a question', () => {
    const env = makeEnv();
    const state = customGame(['ana'], env);
    expect(quizReducer(state, answer('stranger', 1), env)).toBe(state);
    expect(quizReducer(state, answer('ana', 3), env)).toBe(state);
    const lobby = lobbyWith('ana');
    expect(quizReducer(lobby, answer('ana', 0), env)).toBe(lobby);
  });

  it('accepts an answer in flight up to the grace period, then locks', () => {
    const env = makeEnv();
    const state = customGame(['ana', 'ben'], env);
    env.clock.advance(20_000 + QUIZ_ANSWER_GRACE_MS);
    const late = quizReducer(state, answer('ana', 1), env);
    expect(late.answers.ana).toEqual({ choice: 1, at: T0 + 20_000 + QUIZ_ANSWER_GRACE_MS });
    env.clock.advance(1);
    expect(quizReducer(state, answer('ben', 1), env)).toBe(state);
  });

  it('reveals as soon as every eligible player has answered', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    state = run(state, [answer('host', 1), answer('ana', 1)], env);
    expect(state.phase).toBe('playing');
    state = quizReducer(state, answer('ben', 0), env);
    expect(state.phase).toBe('reveal');
  });
});

describe('time-up and reveal', () => {
  it('time-up does nothing until the deadline (plus grace) has passed on the SERVER clock', () => {
    const env = makeEnv();
    const state = customGame(['ana'], env);
    env.clock.advance(20_000 + QUIZ_ANSWER_GRACE_MS - 1);
    expect(quizReducer(state, { type: 'time-up' }, env)).toBe(state);
    env.clock.advance(1);
    expect(quizReducer(state, { type: 'time-up' }, env).phase).toBe('reveal');
  });

  it('time-up is a no-op without a deadline or outside a question', () => {
    const env = makeEnv();
    env.clock.advance(3_600_000);
    const lobby = lobbyWith('ana');
    expect(quizReducer(lobby, { type: 'time-up' }, env)).toBe(lobby);
    const noDeadline: QuizState = { ...customGame(['ana'], makeEnv()), deadline: null };
    expect(quizReducer(noDeadline, { type: 'time-up' }, env)).toBe(noDeadline);
  });

  it('publishes counts per option and each player’s result — never who picked what', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben', 'cem'], env);
    state = run(state, [answer('host', 1), answer('ana', 1), answer('ben', 0)], env);
    state = quizReducer(state, { type: 'reveal' }, env);
    expect(state.phase).toBe('reveal');
    expect(state.reveal).toEqual({ index: 0, correctIndex: 1, counts: [1, 2, 0], answered: 3, correct: 2 });
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(byId.host!.lastResult).toBe('correct');
    expect(byId.ana!.lastResult).toBe('correct');
    expect(byId.ben!.lastResult).toBe('wrong');
    expect(byId.cem!.lastResult).toBe('missed');
    expect(byId.ben!.lastGain).toBe(0);
    expect(byId.cem!.answered).toBe(0);
    expect(byId.ben!.answered).toBe(1);
  });

  it('refuses answers once revealed and reveal twice', () => {
    const env = makeEnv();
    const state = quizReducer(customGame(['ana', 'ben'], env), { type: 'reveal' }, env);
    expect(quizReducer(state, answer('ana', 1), env)).toBe(state);
    expect(quizReducer(state, { type: 'reveal' }, env)).toBe(state);
    expect(revealQuestion(state)).toBe(state);
  });
});

describe('scoring', () => {
  it('quizPointsFor: 500 base + up to 500 for speed + streak bonus', () => {
    const start = T0;
    const deadline = T0 + 20_000;
    expect(quizPointsFor(start, start, deadline, 1)).toBe(1_000);
    expect(quizPointsFor(T0 + 10_000, start, deadline, 1)).toBe(750);
    expect(quizPointsFor(deadline, start, deadline, 1)).toBe(500);
    expect(quizPointsFor(deadline + 800, start, deadline, 1)).toBe(500);
    expect(quizPointsFor(T0 + 5_000, start, deadline, 2)).toBe(500 + 375 + 100);
    expect(quizPointsFor(deadline, start, deadline, 3)).toBe(700);
    expect(quizPointsFor(deadline, start, deadline, 4)).toBe(800);
    expect(quizPointsFor(deadline, start, deadline, 9)).toBe(800);
    // No timer (a migrated legacy question): base points only.
    expect(quizPointsFor(0, null, null, 1)).toBe(500);
  });

  it('adds the gain at the reveal and tracks streaks across questions', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    // Q1 — host right instantly, ana right at half time, ben wrong.
    state = quizReducer(state, answer('host', 1), env);
    env.clock.advance(10_000);
    state = run(state, [answer('ana', 1), answer('ben', 0)], env);
    const q1 = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(q1.host).toMatchObject({ score: 1_000, lastGain: 1_000, streak: 1, correct: 1 });
    expect(q1.ana).toMatchObject({ score: 750, lastGain: 750, streak: 1 });
    expect(q1.ben).toMatchObject({ score: 0, streak: 0, lastResult: 'wrong' });

    // Q2 — everyone right at the deadline: host and ana get the streak bonus.
    state = quizReducer(state, { type: 'next' }, env);
    env.clock.advance(20_000);
    state = run(state, [answer('host', 1), answer('ana', 1), answer('ben', 1)], env);
    const q2 = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(q2.host).toMatchObject({ score: 1_600, lastGain: 600, streak: 2, bestStreak: 2 });
    expect(q2.ana).toMatchObject({ score: 1_350, lastGain: 600, streak: 2 });
    expect(q2.ben).toMatchObject({ score: 500, lastGain: 500, streak: 1 });

    // Q3 — host misses (silent), the streak breaks; ben keeps going.
    state = quizReducer(state, { type: 'next' }, env);
    state = run(state, [answer('ana', 0), answer('ben', 2)], env);
    state = quizReducer(state, { type: 'reveal' }, env);
    const q3 = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(q3.host).toMatchObject({ score: 1_600, streak: 0, bestStreak: 2, lastResult: 'missed', lastGain: 0 });
    expect(q3.ana).toMatchObject({ streak: 0, lastResult: 'wrong' });
    expect(q3.ben).toMatchObject({ score: 500 + 1_000 + 100, streak: 2, lastResult: 'correct' });
  });
});

describe('next and end', () => {
  it('next opens the following question with a fresh deadline and clears the answers', () => {
    const env = makeEnv();
    let state = quizReducer(customGame(['ana'], env), { type: 'reveal' }, env);
    env.clock.advance(30_000);
    state = quizReducer(state, { type: 'next' }, env);
    expect(state).toMatchObject({ phase: 'playing', currentIndex: 1, answers: {}, reveal: null });
    expect(state.questionStartedAt).toBe(T0 + 30_000);
    expect(state.deadline).toBe(T0 + 50_000);
    expect(state.current).toEqual({ index: 1, question: QUESTIONS[1]!.question, options: QUESTIONS[1]!.options });
  });

  it('next only works from a reveal; after the last question it ends the quiz', () => {
    const env = makeEnv();
    let state = customGame(['ana'], env);
    expect(quizReducer(state, { type: 'next' }, env)).toBe(state);
    for (let i = 0; i < 3; i += 1) {
      state = quizReducer(state, { type: 'reveal' }, env);
      state = quizReducer(state, { type: 'next' }, env);
    }
    expect(state).toMatchObject({ phase: 'ended', endReason: 'completed', current: null, deadline: null });
    expect(state.endedAt).toBe(T0);
  });

  it('ending mid-question voids it: nobody scores the unrevealed question', () => {
    const env = makeEnv();
    let state = run(customGame(['ana'], env), [answer('ana', 1)], env);
    state = quizReducer(state, { type: 'end' }, env);
    expect(state).toMatchObject({ phase: 'ended', endReason: 'host', answers: {}, reveal: null });
    expect(state.players.every((p) => p.score === 0)).toBe(true);
  });

  it('ending on the last reveal counts as completed; ending the lobby does nothing', () => {
    const env = makeEnv();
    let state = customGame(['ana'], env, QUESTIONS.slice(0, 1));
    state = quizReducer(state, { type: 'reveal' }, env);
    expect(quizReducer(state, { type: 'end' }, env).endReason).toBe('completed');
    const lobby = lobbyWith('ana');
    expect(quizReducer(lobby, { type: 'end' }, env)).toBe(lobby);
  });

  it('nothing moves once the quiz has ended', () => {
    const env = makeEnv();
    const ended = quizReducer(customGame(['ana'], env), { type: 'end' }, env);
    const actions: QuizAction[] = [
      { type: 'join', playerId: 'zed' },
      { type: 'leave', playerId: 'ana' },
      answer('ana', 1),
      { type: 'time-up' },
      { type: 'reveal' },
      { type: 'next' },
      { type: 'end' },
      packStart({ packId: 'general', language: 'en' }),
    ];
    for (const action of actions) expect(quizReducer(ended, action, env)).toBe(ended);
  });
});

describe('late joiners, spectators and leavers', () => {
  it('a player who joins mid-question answers from the NEXT question', () => {
    const env = makeEnv();
    let state = customGame(['ana'], env);
    state = quizReducer(state, { type: 'join', playerId: 'late' });
    expect(state.players.find((p) => p.id === 'late')).toMatchObject({ eligibleFrom: 1, active: true });
    // Cannot answer the open question, and does not hold up "everyone answered".
    expect(quizReducer(state, answer('late', 1), env)).toBe(state);
    state = run(state, [answer('host', 1), answer('ana', 1)], env);
    expect(state.phase).toBe('reveal');
    expect(state.players.find((p) => p.id === 'late')!.lastResult).toBeNull();
    state = quizReducer(state, { type: 'next' }, env);
    state = quizReducer(state, answer('late', 1), env);
    expect(state.answers.late).toBeDefined();
  });

  it('joining during a reveal also starts from the next question', () => {
    const env = makeEnv();
    const state = quizReducer(quizReducer(customGame(['ana'], env), { type: 'reveal' }, env), { type: 'join', playerId: 'late' });
    expect(state.players.find((p) => p.id === 'late')!.eligibleFrom).toBe(1);
  });

  it('a leaver keeps their points; their locked answer still counts', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    state = run(state, [answer('ana', 1), { type: 'leave', playerId: 'ana' }], env);
    expect(state.players.find((p) => p.id === 'ana')!.active).toBe(false);
    state = quizReducer(state, { type: 'reveal' }, env);
    expect(state.players.find((p) => p.id === 'ana')).toMatchObject({ lastResult: 'correct', active: false });
    expect(state.players.find((p) => p.id === 'ana')!.score).toBeGreaterThan(0);
  });

  it('when the last player still thinking leaves, the question is revealed', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    state = run(state, [answer('host', 1), answer('ana', 1)], env);
    state = quizReducer(state, { type: 'leave', playerId: 'ben' }, env);
    expect(state.phase).toBe('reveal');
    expect(state.players.find((p) => p.id === 'ben')!.lastResult).toBeNull();
  });

  it('coming back re-activates the player from the next question, score intact', () => {
    const env = makeEnv();
    let state = customGame(['ana'], env);
    state = run(state, [answer('host', 1), answer('ana', 1)], env);
    const scored = state.players.find((p) => p.id === 'ana')!.score;
    state = quizReducer(state, { type: 'next' }, env);
    state = quizReducer(state, { type: 'leave', playerId: 'ana' }, env);
    state = quizReducer(state, { type: 'join', playerId: 'ana' }, env);
    expect(state.players.find((p) => p.id === 'ana')).toMatchObject({ active: true, eligibleFrom: 2, score: scored });
    expect(quizReducer(state, answer('ana', 1), env)).toBe(state);
  });

  it('a silent player loses their streak, someone who sat the question out keeps it', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    state = run(state, [answer('host', 1), answer('ana', 1), answer('ben', 1)], env);
    state = quizReducer(state, { type: 'next' }, env);
    state = quizReducer(state, { type: 'leave', playerId: 'ben' }, env);
    state = run(state, [answer('host', 1)], env);
    state = quizReducer(state, { type: 'reveal' }, env);
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    expect(byId.ana).toMatchObject({ streak: 0, lastResult: 'missed' });
    expect(byId.ben).toMatchObject({ streak: 1, lastResult: null });
  });
});

describe('hidden information stays in the secret fields', () => {
  it('while a question is open, the public fields carry no answer', () => {
    const env = makeEnv();
    let state = customGame(['ana', 'ben'], env);
    state = quizReducer(state, answer('ana', 1), env);
    const { deck: _deck, answers: _answers, ...publicPart } = state;
    const json = JSON.stringify(publicPart);
    expect(json).not.toContain('correctIndex');
    expect(state.reveal).toBeNull();
    expect(publicPart.players.every((p) => p.score === 0 && p.answered === 0)).toBe(true);
  });
});

describe('randomness', () => {
  it('comes only from the server env — the action cannot seed it', () => {
    const start = (seed: number, extra: Record<string, unknown> = {}) =>
      quizReducer(
        lobbyWith('ana'),
        { ...packStart({ packId: 'science', language: 'en', questionCount: 10 }), ...extra } as QuizAction,
        makeEnv(new Clock(), seeded(seed))
      ).deck.map((q) => q.id);
    expect(start(1, { seed: 99, random: 0 })).toEqual(start(1));
    expect(start(1)).not.toEqual(start(2));
  });
});
