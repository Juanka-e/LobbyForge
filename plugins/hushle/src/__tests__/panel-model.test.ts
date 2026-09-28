import { describe, expect, it } from 'vitest';
import { hushleReducer } from '../actions';
import { HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION, createHushleInitialState, type HushleState } from '../state';
import {
  DIFFICULTY_PRESETS,
  EMPTY_TURN_LOG,
  advanceTurnLog,
  draftOf,
  explainerCandidates,
  gameTotals,
  isTurnRunning,
  nextTurnPreview,
  percentages,
  playRole,
  presetFor,
  seatedIds,
  setTeamsAction,
  setupFromSettings,
  splitIntoTeams,
  standings,
  startGameAction,
  turnDeadline,
  turnNumber,
  withPlayerAdded,
  withPlayerRemoved,
  withoutTeam,
  type TurnLog,
} from '../ui/model';
import { JUNO, KAYA, LIGHTHOUSE, MIRA, NOVA, SAM, THEO, playingState, project, teamSetupState, testDeck } from './harness';

describe('who the viewer is this turn', () => {
  const state = playingState();

  it('matches the roles the server projection uses', () => {
    expect(playRole(state, MIRA)).toBe('explainer');
    expect(playRole(state, THEO)).toBe('guesser');
    expect(playRole(state, KAYA)).toBe('opponent');
    expect(playRole(state, JUNO)).toBe('opponent');
    expect(playRole(state, NOVA)).toBe('floater');
    expect(playRole(state, SAM)).toBe('spectator');
  });

  it('gives the card to exactly the viewers that role says can see it', () => {
    for (const viewer of [MIRA, THEO, KAYA, JUNO, NOVA, SAM]) {
      const seesCard = project(state, viewer).currentCard !== null;
      expect(seesCard).toBe(['explainer', 'opponent'].includes(playRole(state, viewer)));
    }
  });

  it('lets the host hand the turn to anyone in the explaining team\'s rotation', () => {
    // Ice's rotation: Mira, the floater's slot, Theo.
    expect(explainerCandidates(state)).toEqual([MIRA, NOVA, THEO]);
  });
});

describe('turn and timer', () => {
  const at = (iso: string) => Date.parse(iso);

  it('counts down to the deadline in state, and not while paused or between turns', () => {
    const start = '2026-01-01T00:00:00.000Z';
    expect(turnDeadline({ startedAt: start, durationSeconds: 60, paused: false, endsAt: '2026-01-01T00:01:00.000Z' })).toBe(
      at('2026-01-01T00:01:00.000Z')
    );
    // The deadline wins over start + duration: every client counts to the same moment.
    expect(turnDeadline({ startedAt: start, durationSeconds: 60, paused: false, endsAt: '2026-01-01T00:00:45.000Z' })).toBe(
      at('2026-01-01T00:00:45.000Z')
    );
    // A timer written before deadlines were stored counts from its start.
    expect(turnDeadline({ startedAt: start, durationSeconds: 60, paused: false, endsAt: null })).toBe(
      at('2026-01-01T00:01:00.000Z')
    );
    expect(turnDeadline({ startedAt: start, durationSeconds: 60, paused: true, endsAt: null })).toBeNull();
    expect(turnDeadline({ startedAt: null, durationSeconds: 60, paused: false, endsAt: null })).toBeNull();
    expect(turnDeadline({ startedAt: 'not a date', durationSeconds: 60, paused: false, endsAt: null })).toBeNull();
    expect(turnDeadline(undefined)).toBeNull();
  });

  it('keeps one deadline for the whole turn, card after card', () => {
    const first = playingState();
    const later = hushleReducer(hushleReducer(first, { type: 'correct-guess' }), { type: 'pass' });
    expect(turnDeadline(later.timer)).toBe(turnDeadline(first.timer));
    expect(turnDeadline(first.timer)! - Date.parse(first.timer.startedAt!)).toBe(first.settings.turnDurationSeconds * 1000);
  });

  it('tells a running turn from the pause between turns', () => {
    const running = playingState();
    expect(isTurnRunning(running)).toBe(true);
    let s = running;
    for (let i = 0; i < s.settings.cardsPerTurn; i += 1) s = hushleReducer(s, { type: 'correct-guess' });
    expect(s.phase).toBe('playing');
    expect(isTurnRunning(s)).toBe(false);
    expect(isTurnRunning(teamSetupState())).toBe(false);
  });

  it('numbers turns as the reducer counts them', () => {
    const first = playingState();
    expect(turnNumber(first)).toBe(1);
    expect(turnNumber(hushleReducer(first, { type: 'end-turn' }))).toBe(2);
  });

  it('previews exactly who end-turn hands the next turn to, round after round', () => {
    let s: HushleState = playingState();
    const explainers = [s.currentExplainerId];
    for (let turn = 0; turn < 6; turn += 1) {
      const preview = nextTurnPreview(s);
      const after = hushleReducer(s, { type: 'end-turn' });
      expect(preview?.team.id).toBe(after.currentTeamId);
      expect(preview?.explainerId).toBe(after.currentExplainerId);
      explainers.push(after.currentExplainerId);
      s = after;
    }
    // Two teams of two and a floater: everyone explains, the floater once per team.
    expect(explainers).toEqual([MIRA, KAYA, NOVA, JUNO, THEO, NOVA, MIRA]);
  });

  it('previews the floater for a team with nobody to explain', () => {
    let s = createHushleInitialState();
    s = hushleReducer(s, { type: 'start-game', packId: 'hushle-en-basic', createdBy: KAYA, deck: testDeck() });
    s = hushleReducer(s, {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: [KAYA] },
        { name: 'B', playerIds: [] },
      ],
      floaterPlayerId: NOVA,
    });
    s = hushleReducer(s, { type: 'start-turn', teamId: s.teams[0]!.id, explainerId: KAYA });
    const after = hushleReducer(s, { type: 'end-turn' });
    expect(nextTurnPreview(s)).toEqual({ team: s.teams[1], explainerId: NOVA });
    expect(after.currentExplainerId).toBe(NOVA);
  });
});

describe('scores', () => {
  const withScores = (ice: number, amber: number) => {
    const s = playingState();
    return {
      ...s,
      teams: [
        { ...s.teams[0]!, score: ice, correctCount: ice + 1, passCount: 2, penaltyCount: 1 },
        { ...s.teams[1]!, score: amber, correctCount: amber, passCount: 1, penaltyCount: 0 },
      ],
      totalCardsPlayed: 9,
    };
  };

  it('ranks teams and names the leader', () => {
    const { ranked, leaders } = standings(withScores(1, 3).teams);
    expect(ranked.map((team) => team.name)).toEqual(['Amber', 'Ice']);
    expect(leaders.map((team) => team.name)).toEqual(['Amber']);
  });

  it('keeps every team that shares the top score, in seat order', () => {
    const { ranked, leaders } = standings(withScores(2, 2).teams);
    expect(ranked.map((team) => team.name)).toEqual(['Ice', 'Amber']);
    expect(leaders.map((team) => team.name)).toEqual(['Ice', 'Amber']);
    expect(standings([]).leaders).toEqual([]);
  });

  it('adds up the game', () => {
    expect(gameTotals(withScores(1, 3))).toEqual({ played: 9, guessed: 5, skipped: 3, busted: 1 });
  });
});

describe('lobby settings', () => {
  it('offers the reducer default as "mixed", and names presets back', () => {
    expect(DIFFICULTY_PRESETS.mixed).toEqual(HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION);
    expect(presetFor(HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION)).toBe('mixed');
    expect(presetFor({ easy: 0.8, medium: 0.2, hard: 0 })).toBe('easier');
    expect(presetFor({ easy: 0.5, medium: 0.5, hard: 0 })).toBeNull();
    expect(percentages(DIFFICULTY_PRESETS.harder)).toEqual({ easy: 20, medium: 40, hard: 40 });
  });

  it('starts a game the reducer takes as-is', () => {
    const action = startGameAction(
      {
        packId: 'hushle-tr-basic',
        language: 'tr',
        turnDurationSeconds: 45,
        cardsPerTurn: 10,
        teamSize: 3,
        difficultyDistribution: DIFFICULTY_PRESETS.harder,
      },
      KAYA
    );
    expect(action).toEqual({
      type: 'start-game',
      packId: 'hushle-tr-basic',
      language: 'tr',
      turnDurationSeconds: 45,
      cardsPerTurn: 10,
      teamSize: 3,
      difficultyDistribution: { easy: 0.2, medium: 0.4, hard: 0.4 },
      createdBy: KAYA,
    });
    const next = hushleReducer(createHushleInitialState(), action);
    expect(next.phase).toBe('team_setup');
    expect(next.settings).toMatchObject({
      packId: 'hushle-tr-basic',
      language: 'tr',
      turnDurationSeconds: 45,
      cardsPerTurn: 10,
      teamSize: 3,
    });
    expect(presetFor(next.settings.difficultyDistribution)).toBe('harder');
  });

  it('starts the next game with the settings of the last one', () => {
    const played = playingState();
    const again = hushleReducer(played, startGameAction(setupFromSettings(played.settings), KAYA));
    const { difficultyDistribution, ...rest } = again.settings;
    const { difficultyDistribution: before, ...restBefore } = played.settings;
    expect(rest).toEqual(restBefore);
    // The reducer renormalises the weights, so compare them loosely.
    for (const tier of ['easy', 'medium', 'hard'] as const) {
      expect(difficultyDistribution[tier]).toBeCloseTo(before[tier], 9);
    }
    expect(presetFor(difficultyDistribution)).toBe('mixed');
  });
});

describe('team edits — set-teams always carries the whole roster', () => {
  const state = teamSetupState();

  it('splits the room into two even teams, the odd one out floating', () => {
    const names: [string, string] = ['Ice', 'Amber'];
    const room = [MIRA, THEO, KAYA, JUNO, NOVA];
    const { teams, floaterPlayerId } = splitIntoTeams(room, 2, names);
    expect(teams.map((team) => team.name)).toEqual(names);
    expect(teams.map((team) => team.playerIds.length)).toEqual([2, 2]);
    // Everyone is placed exactly once.
    expect([...teams.flatMap((team) => team.playerIds), floaterPlayerId].sort()).toEqual([...room].sort());
    // Teams stay even when the team size has room to spare.
    expect(splitIntoTeams(room, 3, names).teams.map((team) => team.playerIds.length)).toEqual([2, 2]);
    // An even room has no floater.
    expect(splitIntoTeams([MIRA, THEO, KAYA, JUNO], 2, names).floaterPlayerId).toBeNull();
    // Beyond two full teams and a floater, the rest wait.
    const crowd = splitIntoTeams([MIRA, THEO, KAYA, JUNO, NOVA, SAM, 'u-extra'], 2, names);
    expect(crowd.teams.flatMap((team) => team.playerIds)).toHaveLength(4);
    expect(crowd.floaterPlayerId).not.toBeNull();
  });

  it('shuffles by the random source it is given, and the reducer takes the result', () => {
    const first = () => 0;
    const { teams, floaterPlayerId } = splitIntoTeams([MIRA, THEO, KAYA, JUNO, NOVA], 2, ['Ice', 'Amber'], first);
    // With random() always 0 the Fisher–Yates shuffle rotates the list by one.
    expect(teams).toEqual([
      { name: 'Ice', playerIds: [THEO, KAYA] },
      { name: 'Amber', playerIds: [JUNO, NOVA] },
    ]);
    expect(floaterPlayerId).toBe(MIRA);
    const next = hushleReducer(teamSetupState({ teams: false }), setTeamsAction(teams, floaterPlayerId));
    expect(next.teams.map((team) => team.playerIds)).toEqual([
      [THEO, KAYA],
      [JUNO, NOVA],
    ]);
    expect(next.floaterPlayerId).toBe(MIRA);
  });

  it('keeps the classic payload without a floater, and carries the floater when there is one', () => {
    const teams = draftOf(state.teams);
    expect(setTeamsAction(teams, null)).toEqual({ type: 'set-teams', teams });
    expect(Object.keys(setTeamsAction(teams, null))).toEqual(['type', 'teams']);
    expect(setTeamsAction(teams, NOVA)).toEqual({ type: 'set-teams', teams, floaterPlayerId: NOVA });
  });

  it('seats, unseats and removes', () => {
    expect(seatedIds(state)).toEqual(new Set([MIRA, THEO, KAYA, JUNO, NOVA]));
    const ice = state.teams[0]!;
    expect(withPlayerAdded(state.teams, ice.id, SAM)[0]).toEqual({ name: 'Ice', playerIds: [MIRA, THEO, SAM] });
    expect(withPlayerAdded(state.teams, ice.id, MIRA)[0]).toEqual({ name: 'Ice', playerIds: [MIRA, THEO] });
    expect(withPlayerRemoved(state.teams, THEO)[0]).toEqual({ name: 'Ice', playerIds: [MIRA] });
    expect(withoutTeam(state.teams, ice.id)).toEqual([{ name: 'Amber', playerIds: [KAYA, JUNO] }]);
    // Round-trips through the reducer without losing the floater.
    const next = hushleReducer(state, setTeamsAction(withPlayerRemoved(state.teams, THEO), state.floaterPlayerId));
    expect(next.teams.map((team) => team.playerIds)).toEqual([[MIRA], [KAYA, JUNO]]);
    expect(next.floaterPlayerId).toBe(NOVA);
  });
});

describe('"this turn" log', () => {
  /** Feed a sequence of reducer states to the log, as one viewer sees them. */
  const replay = (states: HushleState[], viewer: string): TurnLog => {
    let log = EMPTY_TURN_LOG;
    let prev = null as ReturnType<typeof project> | null;
    for (const state of states) {
      const view = project(state, viewer);
      log = advanceTurnLog(log, prev, view);
      prev = view;
    }
    return log;
  };

  // Pin each drawn card so words are predictable.
  const pinned = (state: HushleState, word: string): HushleState =>
    state.currentCard ? { ...state, currentCard: { ...state.currentCard, id: `pinned-${word}`, word } } : state;

  const turn = (): HushleState[] => {
    const s0 = playingState();
    const s1 = pinned(hushleReducer(s0, { type: 'correct-guess' }), 'umbrella');
    const s2 = pinned(hushleReducer(s1, { type: 'pass' }), 'pyramid');
    // Cap is 3 cards per turn: this bust ends the turn.
    const s3 = hushleReducer(s2, { type: 'bust-forbidden', bustedBy: JUNO });
    return [s0, s1, s2, s3];
  };

  it('records each card and its outcome for a viewer who saw the cards', () => {
    const log = replay(turn(), MIRA);
    expect(log.entries.map((entry) => [entry.word, entry.outcome])).toEqual([
      [LIGHTHOUSE.word, 'correct'],
      ['umbrella', 'pass'],
      ['pyramid', 'penalty'],
    ]);
  });

  it('keeps the words from the explaining team, who never saw them', () => {
    const log = replay(turn(), THEO);
    expect(log.entries.map((entry) => [entry.word, entry.outcome])).toEqual([
      [null, 'correct'],
      [null, 'pass'],
      [null, 'penalty'],
    ]);
  });

  it('keeps the finished turn on show between turns, and clears it when the next turn starts', () => {
    const states = turn();
    const between = states[states.length - 1]!;
    expect(isTurnRunning(between)).toBe(false);
    expect(replay(states, KAYA).entries).toHaveLength(3);
    const next = hushleReducer(between, { type: 'end-turn' });
    expect(replay([...states, next], KAYA).entries).toEqual([]);
  });

  it('notes a card swapped without scoring', () => {
    const s0 = playingState();
    const s1 = hushleReducer(s0, { type: 'next-card' });
    expect(replay([s0, s1], KAYA).entries.map((entry) => entry.outcome)).toEqual(['next']);
  });

  it('starts empty when the panel opens mid-turn, and on a new game', () => {
    expect(replay([playingState()], KAYA).entries).toEqual([]);
    const played = turn();
    const fresh = hushleReducer(played[played.length - 1]!, startGameAction(setupFromSettings(played[0]!.settings), KAYA));
    expect(replay([...played, fresh], KAYA).entries).toEqual([]);
  });

  it('does not pin a word on events it saw only in a batch', () => {
    const s0 = playingState();
    const s2 = hushleReducer(hushleReducer(s0, { type: 'correct-guess' }), { type: 'correct-guess' });
    const log = replay([s0, s2], MIRA);
    expect(log.entries.map((entry) => [entry.word, entry.outcome])).toEqual([
      [null, 'correct'],
      [null, 'correct'],
    ]);
  });
});
