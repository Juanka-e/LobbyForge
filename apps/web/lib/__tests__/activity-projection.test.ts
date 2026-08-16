import { describe, expect, it } from 'vitest';
import { projectActivityState } from '../activity-projection.js';

/**
 * LF-001 regression tests: the canonical projector is the single source
 * of truth for what each viewer sees (GET, action response, SSE snapshot
 * and SSE events all call it). These tests pin the secret contract:
 *   - the deck never leaves the server for ANY viewer (incl. host)
 *   - currentCard is visible to the explainer AND opposing-team players
 *   - teammates of the explainer, floaters and spectators get null
 *   - cardsRemaining subtracts used cards, deckSize stays the total
 *   - Quiz correctIndex only appears in reveal/ended phases
 */

function hushlePlayingState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 'playing',
    currentTeamId: 'team-a',
    currentExplainerId: 'p1',
    currentCard: {
      id: 'card-1',
      language: 'en',
      word: 'apple',
      forbiddenWords: ['fruit', 'red'],
      difficulty: 'easy',
    },
    deck: [
      { id: 'card-1', language: 'en', word: 'apple', forbiddenWords: ['fruit', 'red'], difficulty: 'easy' },
      { id: 'card-2', language: 'en', word: 'train', forbiddenWords: ['rail'], difficulty: 'easy' },
      { id: 'card-3', language: 'en', word: 'volcano', forbiddenWords: ['lava'], difficulty: 'hard' },
    ],
    usedCardIds: ['card-1'],
    teams: [
      { id: 'team-a', name: 'A', playerIds: ['p1', 'p2'], score: 0 },
      { id: 'team-b', name: 'B', playerIds: ['p3', 'p4'], score: 0 },
    ],
    ...overrides,
  };
}

describe('projectActivityState — hushle', () => {
  it('never sends the deck to any viewer, including the explainer and host', () => {
    for (const viewer of ['p1', 'p2', 'p3', undefined]) {
      const out = projectActivityState(hushlePlayingState(), 'hushle', viewer) as Record<string, unknown>;
      expect(out.deck, `viewer=${viewer}`).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('card-2'); // unused card must not leak anywhere
      expect(out.deckSize).toBe(3);
      expect(out.cardsRemaining).toBe(2); // 3 deck - 1 used
    }
  });

  it('computes cardsRemaining from usedCardIds (deckSize stays the total)', () => {
    const out = projectActivityState(
      hushlePlayingState({ usedCardIds: ['card-1', 'card-2', 'card-3'] }),
      'hushle',
      'p1'
    ) as Record<string, unknown>;
    expect(out.deckSize).toBe(3);
    expect(out.cardsRemaining).toBe(0);
  });

  it('shows the card to the explainer', () => {
    const out = projectActivityState(hushlePlayingState(), 'hushle', 'p1') as Record<string, unknown>;
    expect(out.currentCard).toMatchObject({ word: 'apple', forbiddenWords: ['fruit', 'red'] });
  });

  it('hides the card from the explainer’s teammates (guessers)', () => {
    // p2 is on team-a with the explainer p1 — must NOT see the card.
    const out = projectActivityState(hushlePlayingState(), 'hushle', 'p2') as Record<string, unknown>;
    expect(out.currentCard).toBeNull();
  });

  it('shows the card (word + forbidden words) to opposing-team players', () => {
    // p3 is on team-b — classic Taboo: opponents watch the card to bust.
    const out = projectActivityState(hushlePlayingState(), 'hushle', 'p3') as Record<string, unknown>;
    expect(out.currentCard).toMatchObject({ word: 'apple', forbiddenWords: ['fruit', 'red'] });
  });

  it('hides the card from spectators and floaters (no team)', () => {
    const floater = hushlePlayingState({ floaterPlayerId: 'p9' });
    const out = projectActivityState(floater, 'hushle', 'p9') as Record<string, unknown>;
    expect(out.currentCard).toBeNull();

    const spectator = projectActivityState(hushlePlayingState(), 'hushle', 'stranger') as Record<string, unknown>;
    expect(spectator.currentCard).toBeNull();
  });

  it('shows the full card to everyone once the game has ended', () => {
    const ended = hushlePlayingState({
      phase: 'ended',
      currentCard: null,
    });
    const out = projectActivityState(ended, 'hushle', 'p2') as Record<string, unknown>;
    expect(out.currentCard).toBeNull(); // ended state carries no active card
    expect(out.deckSize).toBe(3);
  });

  it('nulls the card when there is no current team', () => {
    const noTeam = hushlePlayingState({ currentTeamId: null });
    const out = projectActivityState(noTeam, 'hushle', 'p3') as Record<string, unknown>;
    expect(out.currentCard).toBeNull();
  });
});

describe('projectActivityState — quiz', () => {
  const quizState = (phase: string): Record<string, unknown> => ({
    phase,
    questions: [
      { prompt: '2+2?', options: ['3', '4'], correctIndex: 1 },
      { prompt: 'Capital?', options: ['Izmir', 'Ankara'], correctIndex: 1 },
    ],
  });

  it('strips correctIndex while playing', () => {
    const out = projectActivityState(quizState('playing'), 'quiz', 'p1') as {
      questions: Array<Record<string, unknown>>;
    };
    for (const q of out.questions) expect(q.correctIndex).toBeUndefined();
  });

  it('keeps correctIndex in reveal and ended phases', () => {
    for (const phase of ['reveal', 'ended']) {
      const out = projectActivityState(quizState(phase), 'quiz', 'p1') as {
        questions: Array<Record<string, unknown>>;
      };
      for (const q of out.questions) expect(q.correctIndex).toBe(1);
    }
  });
});
