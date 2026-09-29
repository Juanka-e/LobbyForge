/**
 * Quiz hidden information (state v2, plugins/quiz/src/state.ts).
 *
 * The canonical state keeps two secrets:
 *   - `deck`    every question of the game WITH its correct answer;
 *   - `answers` who picked which option on the open question.
 * Everything else is public: `current` is the open question without its
 * answer, `reveal` holds per-option COUNTS once a question is revealed.
 *
 * The fixture is question 2 of a 3-question pack game with four players
 * (the host plays too) and a spectator ("watcher") who never joined.
 * Every option text is unique across the deck, so a leak of a future
 * question — or of an answer — shows up as a plain substring.
 */
import { describe, expect, it } from 'vitest';
import { projectActivityState } from '../activity-projection.js';

type Rec = Record<string, unknown>;

const PLUGIN = 'quiz';
const VIEWERS = ['host', 'ana', 'ben', 'cem', 'watcher', undefined] as const;

const deck = [
  { id: 'gen-en-01', question: 'Who painted the Mona Lisa?', options: ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Rembrandt'], correctIndex: 1 },
  { id: 'gen-en-07', question: 'Which chess piece can only move diagonally?', options: ['Rook', 'Knight', 'King', 'Bishop'], correctIndex: 3 },
  { id: 'gen-en-19', question: 'How many rings are on the Olympic flag?', options: ['Four rings', 'Five rings', 'Six rings', 'Seven rings'], correctIndex: 1 },
];

const player = (id: string, score: number, extra: Rec = {}): Rec => ({
  id,
  name: null,
  eligibleFrom: 0,
  active: true,
  score,
  correct: score > 0 ? 1 : 0,
  answered: 1,
  streak: score > 0 ? 1 : 0,
  bestStreak: score > 0 ? 1 : 0,
  lastGain: score,
  lastResult: score > 0 ? 'correct' : 'wrong',
  ...extra,
});

/** Question 2 open: ana and ben have answered (ana right, ben wrong), host and cem have not. */
function playing(overrides: Rec = {}): Rec {
  return {
    version: 2,
    phase: 'playing',
    settings: { source: 'pack', packId: 'general', packLanguage: 'en', questionCount: 5, secondsPerQuestion: 20, shuffle: true },
    players: [player('host', 900), player('ana', 750), player('ben', 0), player('cem', 0, { eligibleFrom: 1 })],
    deck,
    questionTotal: 3,
    questionsRevealed: 1,
    currentIndex: 1,
    current: { index: 1, question: deck[1]!.question, options: deck[1]!.options },
    questionStartedAt: 1_000,
    deadline: 21_000,
    answers: { ana: { choice: 3, at: 4_000 }, ben: { choice: 0, at: 9_000 } },
    reveal: null,
    startedAt: 0,
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

function revealed(): Rec {
  return playing({
    phase: 'reveal',
    questionsRevealed: 2,
    answers: { ana: { choice: 3, at: 4_000 }, ben: { choice: 0, at: 9_000 }, host: { choice: 3, at: 12_000 } },
    reveal: { index: 1, correctIndex: 3, counts: [1, 0, 0, 2], answered: 3, correct: 2 },
  });
}

const project = (state: Rec, viewer: string | undefined) => projectActivityState(state, PLUGIN, viewer) as Rec;

describe('projectActivityState — quiz v2: the deck never leaves the server', () => {
  it.each(['lobby', 'playing', 'reveal', 'ended'])('no viewer gets the deck in the %s phase — not even the host', (phase) => {
    for (const viewer of VIEWERS) {
      const out = project(playing({ phase }), viewer);
      expect(out.deck, `viewer=${viewer}`).toBeUndefined();
      const json = JSON.stringify(out);
      // Neither the question still to come nor any answer key.
      expect(json).not.toContain('Olympic');
      expect(json).not.toContain('Five rings');
      expect(json).not.toContain('Mona Lisa');
      expect(json).not.toContain('gen-en-');
      expect(json).not.toContain('correctIndex');
    }
  });

  it('keeps the public copy of the open question and the question total', () => {
    const out = project(playing(), 'ana');
    expect(out.current).toEqual({ index: 1, question: deck[1]!.question, options: deck[1]!.options });
    expect(out.questionTotal).toBe(3);
  });

  it('strips an answer from `current` should one ever appear there while the question is open', () => {
    const leaky = playing({ current: { ...deck[1]!, index: 1 } });
    for (const viewer of VIEWERS) {
      const out = project(leaky, viewer);
      expect(out.current as Rec).not.toHaveProperty('correctIndex');
      expect((out.current as Rec).question).toBe(deck[1]!.question);
    }
  });

  it('publishes nothing about the answer before the reveal', () => {
    const early = playing({ reveal: { index: 1, correctIndex: 3, counts: [1, 0, 0, 1], answered: 2, correct: 1 } });
    for (const viewer of VIEWERS) expect(project(early, viewer).reveal).toBeNull();
  });
});

describe('projectActivityState — quiz v2: who answered what stays private', () => {
  it('while playing, each viewer sees how many answered and only their OWN choice', () => {
    expect(project(playing(), 'ana')).toMatchObject({ answeredCount: 2, myAnswer: 3 });
    expect(project(playing(), 'ben')).toMatchObject({ answeredCount: 2, myAnswer: 0 });
    for (const viewer of ['host', 'cem', 'watcher', undefined]) {
      expect(project(playing(), viewer)).toMatchObject({ answeredCount: 2, myAnswer: null });
    }
  });

  it('no viewer gets the answers map, in any phase', () => {
    for (const state of [playing(), revealed(), playing({ phase: 'ended', answers: {} }), playing({ phase: 'lobby', answers: {} })]) {
      for (const viewer of VIEWERS) {
        const out = project(state, viewer);
        expect(out.answers, `viewer=${viewer}`).toBeUndefined();
        expect(JSON.stringify(out)).not.toMatch(/"at":/);
      }
    }
  });

  it('at the reveal the answer and the COUNTS are public, still not who picked what', () => {
    for (const viewer of VIEWERS) {
      const out = project(revealed(), viewer);
      expect(out.reveal).toEqual({ index: 1, correctIndex: 3, counts: [1, 0, 0, 2], answered: 3, correct: 2 });
      expect(out.answers).toBeUndefined();
    }
    expect(project(revealed(), 'ben').myAnswer).toBe(0);
    expect(project(revealed(), 'host').myAnswer).toBe(3);
    expect(project(revealed(), 'cem').myAnswer).toBeNull();
  });

  it('another player’s choice cannot be read from anything the viewer receives', () => {
    // ben answered 0 (Rook). Nothing ana receives ties ben to that option.
    const out = project(playing(), 'ana');
    expect(JSON.stringify(out)).not.toContain('"ben":');
    expect(JSON.stringify(out.players)).not.toContain('choice');
  });

  it('handles a malformed answers blob without leaking or throwing', () => {
    const out = project(playing({ answers: 'garbage' }), 'ana');
    expect(out).toMatchObject({ answeredCount: 0, myAnswer: null });
    expect(out.answers).toBeUndefined();
    const own = project(playing({ answers: { ana: 'x' } }), 'ana');
    expect(own.myAnswer).toBeNull();
  });
});

describe('projectActivityState — quiz v2: hygiene', () => {
  it('never mutates the canonical state', () => {
    const state = playing();
    const before = JSON.stringify(state);
    project(state, 'ana');
    project(revealed(), 'host');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('leaves the public scoreboard alone', () => {
    const out = project(revealed(), 'watcher');
    expect(out.players).toEqual(revealed().players);
    expect(out.settings).toEqual(revealed().settings);
    expect(out.deadline).toBe(21_000);
  });

  it('still applies the legacy rules to a session written before v2', () => {
    const legacy = {
      phase: 'playing',
      currentIndex: 0,
      questions: [{ id: 'q1', question: '2+2?', options: ['3', '4'], correctIndex: 1 }],
      currentAnswers: { alice: 1, bob: 0 },
      playerScores: {},
    };
    const out = project(legacy, 'alice');
    expect((out.questions as Rec[])[0]).not.toHaveProperty('correctIndex');
    expect(out.currentAnswers).toEqual({ alice: 1 });
    expect(out.answeredCount).toBe(2);
  });
});
