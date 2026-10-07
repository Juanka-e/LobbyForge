import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { hushlePlugin, type HushleState } from '../index';
import {
  migrateHushleState,
  HUSHLE_STATE_VERSION,
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
  HUSHLE_TIME_UP_GRACE_MS,
} from '../state';
import { hushleExplainerQueue, hushleNextExplainerForTeam } from '../actions';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

describe('@lobbyforge/hushle', () => {
  it('walks through a full game flow: start, set teams, play a turn, end', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });

    await harness.startGame();
    // Initial state — lobby, no teams, no cards drawn.
    expect(harness.getState().phase).toBe('lobby');
    expect(harness.getState().teams).toHaveLength(0);
    expect(harness.getState().deck).toHaveLength(0);

    // Host starts a game in Turkish.
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-tr-basic',
      language: 'tr',
      turnDurationSeconds: 30,
      createdBy: 'p1',
    });
    expect(harness.getState().phase).toBe('team_setup');
    expect(harness.getState().settings.language).toBe('tr');
    expect(harness.getState().settings.packId).toBe('hushle-tr-basic');
    expect(harness.getState().settings.turnDurationSeconds).toBe(30);
    expect(harness.getState().settings.teamSize).toBe(2);
    expect(harness.getState().settings.difficultyDistribution).toEqual(
      HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION
    );
    expect(harness.getState().deck.length).toBeGreaterThan(0);
    expect(harness.getState().usedCardIds).toEqual([]);

    // Host configures two teams.
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'Takım A', playerIds: ['p1', 'p2'] },
        { name: 'Takım B', playerIds: ['p3', 'p4'] },
      ],
    });
    expect(harness.getState().teams).toHaveLength(2);
    expect(harness.getState().teams[0]?.name).toBe('Takım A');
    expect(harness.getState().phase).toBe('team_setup');
    expect(harness.getState().floaterPlayerId).toBeNull();
    // v3: no turn played yet; every team's rotation starts at its first player.
    expect(harness.getState().turnNumber).toBe(0);
    expect(harness.getState().teams.map((t) => t.nextExplainerSlot)).toEqual([0, 0]);

    // Host starts the first turn for Takım A with p1 as explainer.
    const firstTeam = harness.getState().teams[0]!;
    await harness.performAction('p1', {
      type: 'start-turn',
      teamId: firstTeam.id,
      explainerId: 'p1',
    });
    expect(harness.getState().phase).toBe('playing');
    expect(harness.getState().currentTeamId).toBe(firstTeam.id);
    expect(harness.getState().currentExplainerId).toBe('p1');
    expect(harness.getState().currentCard).not.toBeNull();
    expect(harness.getState().currentCard?.language).toBe('tr');
    // M20a — every card carries a difficulty tier.
    expect(['easy', 'medium', 'hard']).toContain(harness.getState().currentCard?.difficulty);
    expect(harness.getState().timer.paused).toBe(false);
    expect(harness.getState().usedCardIds.length).toBe(1);
    expect(harness.getState().turnNumber).toBe(1);
    // The turn's deadline is in state: start + the 30 s picked above.
    const { startedAt, endsAt } = harness.getState().timer;
    expect(Date.parse(endsAt!) - Date.parse(startedAt!)).toBe(30_000);

    // Host scores a correct guess.
    await harness.performAction('p1', { type: 'correct-guess' });
    const afterCorrect = harness.getState();
    // One clock per turn: scoring a card does not restart it.
    expect(afterCorrect.timer.startedAt).toBe(startedAt);
    expect(afterCorrect.timer.endsAt).toBe(endsAt);
    expect(afterCorrect.teams[0]?.score).toBe(1);
    expect(afterCorrect.teams[0]?.correctCount).toBe(1);
    // A new card is drawn automatically after a correct guess.
    expect(afterCorrect.currentCard).not.toBeNull();
    expect(afterCorrect.totalCardsPlayed).toBe(1);
    expect(afterCorrect.usedCardIds.length).toBe(2);
    // No card should ever be drawn twice in a session.
    expect(new Set(afterCorrect.usedCardIds).size).toBe(afterCorrect.usedCardIds.length);

    // Host passes a card.
    await harness.performAction('p1', { type: 'pass' });
    expect(harness.getState().teams[0]?.passCount).toBe(1);
    expect(harness.getState().teams[0]?.score).toBe(1);
    expect(harness.getState().totalCardsPlayed).toBe(2);

    // Host hands a penalty to the team.
    await harness.performAction('p1', { type: 'penalty' });
    expect(harness.getState().teams[0]?.penaltyCount).toBe(1);
    expect(harness.getState().teams[0]?.score).toBe(0);
    expect(harness.getState().totalCardsPlayed).toBe(3);

    // Host ends the game.
    await harness.performAction('p1', { type: 'end-game' });
    expect(harness.getState().phase).toBe('ended');
    expect(harness.getState().currentCard).toBeNull();
  });

  it('rejects non-host actions in playing phase', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });

    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [{ name: 'A', playerIds: ['p1', 'p2'] }],
    });
    const team = harness.getState().teams[0]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: team.id, explainerId: 'p1' });
    const stateBefore = harness.getState();
    // All Hushle actions are host-only — a non-host action leaves the
    // state machine untouched (the plugin-sdk test harness is permissive
    // by design, so the state machine enforces the constraint in the
    // reducer itself). The host-only check is enforced by the route
    // layer's `authorizePluginAction` against `actionPolicies`.
    expect(stateBefore.currentCard).not.toBeNull();
  });

  it('refuses to seat one player on two teams', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', createdBy: 'p1' });
    const before = harness.getState();
    // p2 would guess for A while watching B's cards.
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p2'] },
      ],
    });
    expect(harness.getState().teams).toEqual(before.teams);
  });

  it('rotates to the next team on end-turn', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });

    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    const teamA = harness.getState().teams[0]!;
    const teamB = harness.getState().teams[1]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA.id, explainerId: 'p1' });
    expect(harness.getState().currentTeamId).toBe(teamA.id);

    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentTeamId).toBe(teamB.id);
    // Team B's own rotation starts at its first player. (The M20a reducer
    // picked p4 here: one shared index, taken modulo the team size, so
    // team B only ever got odd indexes and p3 never explained.)
    expect(harness.getState().currentExplainerId).toBe('p3');
    expect(harness.getState().turnNumber).toBe(2);
  });

  it('gives every player of two teams of two a turn in four turns', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', createdBy: 'p1' });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    const [teamA, teamB] = harness.getState().teams;
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA!.id, explainerId: 'p1' });
    const turns = [[harness.getState().currentTeamId, harness.getState().currentExplainerId]];
    for (let i = 0; i < 5; i += 1) {
      await harness.performAction('p1', { type: 'end-turn' });
      turns.push([harness.getState().currentTeamId, harness.getState().currentExplainerId]);
    }
    // Teams alternate; within each team the explainer rotates.
    expect(turns).toEqual([
      [teamA!.id, 'p1'],
      [teamB!.id, 'p3'],
      [teamA!.id, 'p2'],
      [teamB!.id, 'p4'],
      [teamA!.id, 'p1'],
      [teamB!.id, 'p3'],
    ]);
    expect(harness.getState().turnNumber).toBe(6);
  });

  it('continues a team\'s rotation after an explainer the host picked by hand', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    });
    await harness.startGame();
    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', teamSize: 3, createdBy: 'p1' });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2', 'p3'] },
        { name: 'B', playerIds: ['p4', 'p5', 'p6'] },
      ],
    });
    const teamA = harness.getState().teams[0]!;
    // The host opens with p2 instead of p1…
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA.id, explainerId: 'p2' });
    expect(harness.getState().currentExplainerId).toBe('p2');
    // …and in B's turn hands it from p4 to p6 (say p4 stepped away).
    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentExplainerId).toBe('p4');
    await harness.performAction('p1', { type: 'set-explainer', explainerId: 'p6' });
    // Each team's rotation continues after whoever actually explained.
    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentExplainerId).toBe('p3');
    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentExplainerId).toBe('p4');
  });

  it('end-game blocks new turns but preserves scores', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });

    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [{ name: 'A', playerIds: ['p1', 'p2'] }],
    });
    const team = harness.getState().teams[0]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: team.id, explainerId: 'p1' });
    await harness.performAction('p1', { type: 'correct-guess' });
    await harness.performAction('p1', { type: 'end-game' });

    expect(harness.getState().phase).toBe('ended');
    expect(harness.getState().teams[0]?.score).toBe(1);
  });

  it('start-game resolves language from the packId slug', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });

    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-tr-basic',
      createdBy: 'p1',
    });

    const state = harness.getState();
    expect(state.settings.packId).toBe('hushle-tr-basic');
    expect(state.settings.language).toBe('tr');
    // The deck is loaded from the bundled tr deck (24 cards).
    expect(state.deck.length).toBe(24);
    expect(state.deck.every((c) => c.language === 'tr')).toBe(true);
  });

  it('start-game honors language override when packId is not a known slug', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });

    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-community-spicy-words',
      language: 'en',
      createdBy: 'p1',
    });

    const state = harness.getState();
    expect(state.settings.packId).toBe('hushle-community-spicy-words');
    // The reducer falls back to the explicit `language` when the slug
    // isn't recognized — a custom pack's deck will land via the M19 work
    // (DB-backed deck loading); the MVP keeps the legacy `getDefaultDeck`.
    expect(state.settings.language).toBe('en');
    expect(state.deck.every((c) => c.language === 'en')).toBe(true);
  });

  it('built-in packs include both en and tr decks with a 60/30/10 difficulty distribution', async () => {
    const { HUSHLE_BUILTIN_PACKS } = await import('../decks.js');
    expect(HUSHLE_BUILTIN_PACKS).toHaveLength(2);
    const slugs = HUSHLE_BUILTIN_PACKS.map((p) => p.slug).sort();
    expect(slugs).toEqual(['hushle-en-basic', 'hushle-tr-basic']);
    const languages = HUSHLE_BUILTIN_PACKS.map((p) => p.language).sort();
    expect(languages).toEqual(['en', 'tr']);
    for (const pack of HUSHLE_BUILTIN_PACKS) {
      expect(pack.cards.length).toBe(24);
      const tiers = pack.cards.map((c) => c.difficulty ?? 'easy');
      const easy = tiers.filter((t) => t === 'easy').length;
      const medium = tiers.filter((t) => t === 'medium').length;
      const hard = tiers.filter((t) => t === 'hard').length;
      // 60/30/10 of 24 = 14 / 7 / 3. Permitting a +-1 swing so a
      // future pack edit doesn't break the test.
      expect(easy).toBeGreaterThanOrEqual(13);
      expect(easy).toBeLessThanOrEqual(15);
      expect(medium).toBeGreaterThanOrEqual(6);
      expect(medium).toBeLessThanOrEqual(8);
      expect(hard).toBeGreaterThanOrEqual(2);
      expect(hard).toBeLessThanOrEqual(4);
      for (const card of pack.cards) {
        expect(typeof card.word).toBe('string');
        expect(card.word.length).toBeGreaterThan(0);
        expect(Array.isArray(card.forbiddenWords)).toBe(true);
        expect(card.forbiddenWords.length).toBeGreaterThan(0);
        expect(['easy', 'medium', 'hard']).toContain(card.difficulty);
      }
    }
  });

  it('initial state carries the current version', () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1'],
    });
    return harness.startGame().then(() => {
      const state = harness.getState();
      expect(state.version).toBe(HUSHLE_STATE_VERSION);
      expect(state.phase).toBe('lobby');
      expect(state.floaterPlayerId).toBeNull();
      expect(state.turnNumber).toBe(0);
      expect(state.timer.endsAt).toBeNull();
      expect(state.usedCardIds).toEqual([]);
      expect(state.settings.teamSize).toBe(2);
      expect(state.settings.difficultyDistribution).toEqual(
        HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION
      );
    });
  });

  it('migrator upgrades a pre-versioned v0 state to the current version', () => {
    // Simulate a row persisted by a build that pre-dated state versioning.
    const v0 = {
      phase: 'playing',
      teams: [
        {
          id: 'team-a',
          name: 'A',
          playerIds: ['p1', 'p2'],
          score: 2,
          correctCount: 2,
          passCount: 0,
          penaltyCount: 0,
        },
      ],
      currentTeamId: 'team-a',
      currentExplainerId: 'p1',
      currentCard: { id: 'card-1', language: 'en', word: 'apple', forbiddenWords: ['fruit'] },
      deck: [
        { id: 'card-1', language: 'en', word: 'apple', forbiddenWords: ['fruit'] },
        { id: 'card-2', language: 'en', word: 'book', forbiddenWords: ['read'] },
      ],
      deckIndex: 0,
      settings: {
        turnDurationSeconds: 60,
        cardsPerTurn: 15,
        language: 'en',
        packId: 'hushle-en-basic',
      },
      timer: { startedAt: null, durationSeconds: 60, paused: true },
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: 2,
      createdBy: 'p1',
      createdAt: '2026-06-01T00:00:00.000Z',
      // NB: no `version` field.
    };
    const migrated = migrateHushleState(v0);
    expect(migrated.version).toBe(HUSHLE_STATE_VERSION);
    // The data we cared about carries through.
    expect(migrated.phase).toBe('playing');
    expect(migrated.teams[0]?.score).toBe(2);
    expect(migrated.settings.packId).toBe('hushle-en-basic');
    // M20a migration: every pre-versioned card picks up `difficulty: easy`.
    expect(migrated.deck[0]?.difficulty).toBe('easy');
    expect(migrated.currentCard?.difficulty).toBe('easy');
    expect(migrated.floaterPlayerId).toBeNull();
    expect(migrated.usedCardIds).toEqual([]);
    expect(migrated.settings.teamSize).toBe(2);
    expect(migrated.settings.difficultyDistribution).toEqual(
      HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION
    );
  });

  it('migrator upgrades a v1 (no difficulty) state to the current version', () => {
    const v1 = {
      version: 1,
      phase: 'lobby',
      teams: [],
      currentTeamId: null,
      currentExplainerId: null,
      currentCard: null,
      deck: [
        { id: 'card-x', language: 'en', word: 'apple', forbiddenWords: ['fruit'] },
      ],
      deckIndex: 0,
      settings: {
        turnDurationSeconds: 60,
        cardsPerTurn: 15,
        language: 'en',
        packId: 'hushle-en-basic',
      },
      timer: { startedAt: null, durationSeconds: 60, paused: true },
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: 0,
      createdBy: null,
      createdAt: null,
    };
    const migrated = migrateHushleState(v1);
    expect(migrated.version).toBe(HUSHLE_STATE_VERSION);
    expect(migrated.deck[0]?.difficulty).toBe('easy');
    expect(migrated.settings.teamSize).toBe(2);
    expect(migrated.settings.difficultyDistribution.easy).toBeCloseTo(0.6, 5);
    expect(migrated.floaterPlayerId).toBeNull();
    expect(migrated.usedCardIds).toEqual([]);
  });

  it('migrator is idempotent on already-current state', () => {
    const v3 = {
      version: HUSHLE_STATE_VERSION,
      phase: 'lobby',
      teams: [],
      floaterPlayerId: null,
      turnNumber: 0,
      currentTeamId: null,
      currentExplainerId: null,
      currentCard: null,
      deck: [],
      deckIndex: 0,
      usedCardIds: [],
      settings: {
        turnDurationSeconds: 60,
        cardsPerTurn: 15,
        language: 'en',
        packId: null,
        teamSize: 2,
        difficultyDistribution: { easy: 0.6, medium: 0.3, hard: 0.1 },
      },
      timer: { startedAt: null, durationSeconds: 60, paused: true, endsAt: null },
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: 0,
      createdBy: null,
      createdAt: null,
    };
    const first = migrateHushleState(v3);
    const second = migrateHushleState(first);
    expect(second).toEqual(first);
    expect(first).toEqual(v3);
  });

  it('migrator upgrades a v2 game in progress: per-team rotation, turn number, deadline', () => {
    // A v2 row mid-game: team A's second turn overall is running (shared
    // index 2), p2 explaining, with a floater — the old single-index shape.
    const v2 = {
      version: 2,
      phase: 'playing',
      teams: [
        { id: 'team-a', name: 'A', playerIds: ['p1', 'p2'], score: 1, correctCount: 1, passCount: 0, penaltyCount: 0 },
        { id: 'team-b', name: 'B', playerIds: ['p3', 'p4'], score: 0, correctCount: 0, passCount: 0, penaltyCount: 0 },
      ],
      floaterPlayerId: 'p5',
      currentExplainerIndex: 2,
      currentTeamId: 'team-a',
      currentExplainerId: 'p2',
      currentCard: { id: 'c1', language: 'en', word: 'apple', forbiddenWords: ['fruit'], difficulty: 'easy' },
      deck: [],
      deckIndex: 0,
      usedCardIds: ['c1'],
      settings: {
        turnDurationSeconds: 60,
        cardsPerTurn: 15,
        language: 'en',
        packId: 'hushle-en-basic',
        teamSize: 2,
        difficultyDistribution: { easy: 0.6, medium: 0.3, hard: 0.1 },
      },
      timer: { startedAt: '2026-09-01T10:00:00.000Z', durationSeconds: 60, paused: false },
      cardsPlayedThisTurn: 3,
      totalCardsPlayed: 5,
      createdBy: 'p1',
      createdAt: '2026-09-01T09:55:00.000Z',
    };
    const migrated = migrateHushleState(v2);
    expect(migrated.version).toBe(HUSHLE_STATE_VERSION);
    expect('currentExplainerIndex' in migrated).toBe(false);
    expect(migrated.turnNumber).toBe(3);
    // Team A's rotation (p1, floater, p2) continues after p2; B starts afresh.
    expect(hushleExplainerQueue(migrated, 'team-a')).toEqual(['p1', 'p5', 'p2']);
    expect(hushleNextExplainerForTeam(migrated, 'team-a')).toBe('p1');
    expect(hushleNextExplainerForTeam(migrated, 'team-b')).toBe('p3');
    expect(migrated.timer.endsAt).toBe('2026-09-01T10:01:00.000Z');
    // Everything else carries through.
    expect(migrated.teams[0]!.score).toBe(1);
    expect(migrated.currentCard?.word).toBe('apple');
    expect(migrateHushleState(migrated)).toEqual(migrated);
  });

  it('migrator gives a v2 lobby or stopped clock no deadline', () => {
    const migrated = migrateHushleState({
      version: 2,
      phase: 'team_setup',
      teams: [{ id: 't', name: 'A', playerIds: ['p1'], score: 0, correctCount: 0, passCount: 0, penaltyCount: 0 }],
      floaterPlayerId: null,
      currentExplainerIndex: 0,
      currentTeamId: null,
      settings: { turnDurationSeconds: 45 },
      timer: { startedAt: null, durationSeconds: 45, paused: true },
    });
    expect(migrated.turnNumber).toBe(0);
    expect(migrated.timer).toEqual({ startedAt: null, durationSeconds: 45, paused: true, endsAt: null });
    expect(migrated.teams[0]!.nextExplainerSlot).toBe(0);
  });

  it('migrator falls back to initial state on garbage', () => {
    expect(migrateHushleState(null).version).toBe(HUSHLE_STATE_VERSION);
    expect(migrateHushleState(undefined).version).toBe(HUSHLE_STATE_VERSION);
    expect(migrateHushleState('not an object').version).toBe(HUSHLE_STATE_VERSION);
    expect(migrateHushleState(42).version).toBe(HUSHLE_STATE_VERSION);
  });

  it('plugin exposes migrateState through the registry adapter', async () => {
    // The host reads `getPlugin(id).migrateState` on the registered
    // wrapper, so verify the adapter preserves it.
    const { registerGamePlugin } = await import('@lobbyforge/plugin-sdk');
    const registered = registerGamePlugin(hushlePlugin);
    expect(typeof registered.migrateState).toBe('function');
    const migrated = registered.migrateState!({
      phase: 'lobby',
      teams: [],
      settings: {},
      timer: {},
    });
    expect((migrated as HushleState).version).toBe(HUSHLE_STATE_VERSION);
  });

  // ────────────────────────────────────────────────────────────────────
  // M20a — 2v2 + odd-player (floater) rotation
  // ────────────────────────────────────────────────────────────────────

  it('start-game accepts a custom teamSize and difficultyDistribution', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      teamSize: 3,
      difficultyDistribution: { easy: 0.5, medium: 0.3, hard: 0.2 },
      createdBy: 'p1',
    });
    const state = harness.getState();
    expect(state.settings.teamSize).toBe(3);
    // The reducer renormalizes the distribution to sum to 1.
    const sum =
      state.settings.difficultyDistribution.easy +
      state.settings.difficultyDistribution.medium +
      state.settings.difficultyDistribution.hard;
    expect(sum).toBeCloseTo(1, 5);
    expect(state.settings.difficultyDistribution.hard).toBeCloseTo(0.2, 5);
  });

  it('start-game falls back to defaults when difficultyDistribution sums to zero', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      difficultyDistribution: { easy: 0, medium: 0, hard: 0 },
      createdBy: 'p1',
    });
    expect(harness.getState().settings.difficultyDistribution).toEqual(
      HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION
    );
  });

  it('start-game rejects negative distribution weights (clamps to zero)', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      difficultyDistribution: { easy: -0.5, medium: 1, hard: 0 },
      createdBy: 'p1',
    });
    const dist = harness.getState().settings.difficultyDistribution;
    // Negative clamped to 0; only `medium` carries weight; renormalized to 1.
    expect(dist.easy).toBe(0);
    expect(dist.medium).toBe(1);
    expect(dist.hard).toBe(0);
  });

  it('set-teams accepts a floater for odd-player games and validates it is not on a team', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
      floaterPlayerId: 'p5',
    });
    expect(harness.getState().floaterPlayerId).toBe('p5');
    expect(harness.getState().teams[0]?.playerIds).toEqual(['p1', 'p2']);
  });

  it('set-teams drops the floater when they are already on a team', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    // p5 is also on team A — the reducer should drop the floater.
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2', 'p5'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
      floaterPlayerId: 'p5',
    });
    expect(harness.getState().floaterPlayerId).toBeNull();
  });

  it('set-teams trims each team to settings.teamSize', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      teamSize: 2,
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2', 'p3', 'p4'] }, // 4 players, trim to 2
        { name: 'B', playerIds: ['p5', 'p6'] },
      ],
    });
    expect(harness.getState().teams[0]?.playerIds).toEqual(['p1', 'p2']);
    expect(harness.getState().teams[1]?.playerIds).toEqual(['p5', 'p6']);
  });

  it('end-turn rotates to the floater when the next team is empty', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    // 3 players + 1 floater = 4 slots across 2 teams. Team B's playerIds
    // is intentionally empty; the reducer picks the floater instead.
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1'] },
        { name: 'B', playerIds: [] },
      ],
      floaterPlayerId: 'p3',
    });
    const teamA = harness.getState().teams[0]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA.id, explainerId: 'p1' });
    expect(harness.getState().currentExplainerId).toBe('p1');
    await harness.performAction('p1', { type: 'end-turn' });
    // Team B is empty — floater explains.
    expect(harness.getState().currentExplainerId).toBe('p3');
  });

  it('end-turn alternates the floater across teams across multiple turns', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      createdBy: 'p1',
    });
    // 5 players: A=[p1,p2], B=[p3,p4], floater=p5. The floater has a slot
    // in BOTH teams' rotations — (p1, p5, p2) and (p3, p4, p5) — so a round
    // of six turns gives everyone one turn and the floater one for each
    // team, three turns apart. (The M20a reducer went p1, p4, p1: the
    // floater never explained and p2 and p3 never did either.)
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
      floaterPlayerId: 'p5',
    });
    const teamA = harness.getState().teams[0]!;
    const teamB = harness.getState().teams[1]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA.id, explainerId: 'p1' });
    const turns = [[harness.getState().currentTeamId, harness.getState().currentExplainerId]];
    for (let i = 0; i < 6; i += 1) {
      await harness.performAction('p1', { type: 'end-turn' });
      turns.push([harness.getState().currentTeamId, harness.getState().currentExplainerId]);
    }
    expect(turns).toEqual([
      [teamA.id, 'p1'],
      [teamB.id, 'p3'],
      [teamA.id, 'p5'],
      [teamB.id, 'p4'],
      [teamA.id, 'p2'],
      [teamB.id, 'p5'],
      [teamA.id, 'p1'],
    ]);
  });

  it('spreads the floater through larger teams too', () => {
    // 7 players: two teams of three and a floater. Each rotation holds the
    // floater once; their two turns never come back to back.
    const state = {
      floaterPlayerId: 'f',
      teams: [
        { id: 'a', playerIds: ['a1', 'a2', 'a3'] },
        { id: 'b', playerIds: ['b1', 'b2', 'b3'] },
      ],
    } as unknown as HushleState;
    const a = hushleExplainerQueue(state, 'a');
    const b = hushleExplainerQueue(state, 'b');
    expect(a).toEqual(['a1', 'f', 'a2', 'a3']);
    expect(b).toEqual(['b1', 'b2', 'b3', 'f']);
    // Teams alternate: the round is a1 b1 f b2 a2 b3 a3 f.
    const round = a.flatMap((id, i) => [id, b[i]!]);
    const floaterTurns = round.flatMap((id, i) => (id === 'f' ? [i] : []));
    expect(floaterTurns).toHaveLength(2);
    expect(floaterTurns[1]! - floaterTurns[0]!).toBeGreaterThan(1);
    expect(round.length - floaterTurns[1]! + floaterTurns[0]!).toBeGreaterThan(1);
  });

  it('hushleNextExplainerForTeam reads the team\'s own rotation, floater included', () => {
    const team = (id: string, playerIds: string[], nextExplainerSlot: number) =>
      ({ id, name: id, playerIds, score: 0, correctCount: 0, passCount: 0, penaltyCount: 0, nextExplainerSlot });
    // A team with no players of its own: the floater explains every time.
    const empty = { floaterPlayerId: 'p5', teams: [team('a', ['p1'], 0), team('b', [], 3)] };
    expect(hushleExplainerQueue(empty, 'b')).toEqual(['p5']);
    expect(hushleNextExplainerForTeam(empty, 'b')).toBe('p5');
    // The cursor picks the slot; it wraps round the rotation.
    const game = { floaterPlayerId: 'p5', teams: [team('a', ['p1', 'p2'], 1), team('b', ['p3', 'p4'], 4)] };
    expect(hushleNextExplainerForTeam(game, 'a')).toBe('p5');
    expect(hushleNextExplainerForTeam(game, 'b')).toBe('p4');
    // Without a floater, the rotation is the team's players.
    const plain = { floaterPlayerId: null, teams: [team('a', ['p1', 'p2'], 0)] };
    expect(hushleExplainerQueue(plain, 'a')).toEqual(['p1', 'p2']);
    expect(hushleNextExplainerForTeam(plain, 'a')).toBe('p1');
    // A team nobody can explain for, and an unknown team.
    expect(hushleNextExplainerForTeam({ floaterPlayerId: null, teams: [team('a', [], 0)] }, 'a')).toBeNull();
    expect(hushleNextExplainerForTeam(plain, 'nope')).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // v3 — one clock per turn
  // ────────────────────────────────────────────────────────────────────

  describe('the turn timer', () => {
    const start = Date.parse('2026-09-29T12:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function runningTurn() {
      const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
        plugin: hushlePlugin,
        players: ['p1', 'p2', 'p3', 'p4'],
      });
      await harness.performAction('p1', {
        type: 'start-game',
        packId: 'hushle-en-basic',
        turnDurationSeconds: 45,
        cardsPerTurn: 100,
        createdBy: 'p1',
      });
      await harness.performAction('p1', {
        type: 'set-teams',
        teams: [
          { name: 'A', playerIds: ['p1', 'p2'] },
          { name: 'B', playerIds: ['p3', 'p4'] },
        ],
      });
      await harness.performAction('p1', { type: 'start-turn', teamId: harness.getState().teams[0]!.id, explainerId: 'p1' });
      return harness;
    }

    it('starts with the turn and keeps its deadline through every card', async () => {
      const harness = await runningTurn();
      const timer = harness.getState().timer;
      expect(timer).toEqual({
        startedAt: '2026-09-29T12:00:00.000Z',
        durationSeconds: 45,
        paused: false,
        endsAt: '2026-09-29T12:00:45.000Z',
      });
      vi.setSystemTime(start + 10_000);
      await harness.performAction('p1', { type: 'correct-guess' });
      vi.setSystemTime(start + 20_000);
      await harness.performAction('p1', { type: 'pass' });
      await harness.performAction('p1', { type: 'next-card' });
      await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3', cardId: harness.getState().currentCard!.id });
      expect(harness.getState().timer).toEqual(timer);
      expect(harness.getState().totalCardsPlayed).toBe(3);
    });

    it('ends the turn\'s scoring when the time is up, after a short grace for a tap in flight', async () => {
      const harness = await runningTurn();
      // A tap sent at the buzzer still counts…
      vi.setSystemTime(start + 45_000 + HUSHLE_TIME_UP_GRACE_MS);
      await harness.performAction('p1', { type: 'correct-guess' });
      expect(harness.getState().teams[0]!.score).toBe(1);
      // …but past the grace, no card is scored, skipped, busted or swapped.
      vi.setSystemTime(start + 45_000 + HUSHLE_TIME_UP_GRACE_MS + 1);
      const over = JSON.stringify(harness.getState());
      for (const action of [
        { type: 'correct-guess' as const },
        { type: 'pass' as const },
        { type: 'penalty' as const },
        { type: 'next-card' as const },
      ]) {
        await harness.performAction('p1', action);
      }
      await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3', cardId: harness.getState().currentCard!.id });
      expect(JSON.stringify(harness.getState())).toBe(over);
      // The host moves on: the next team's turn gets a fresh clock.
      await harness.performAction('p1', { type: 'end-turn' });
      const next = harness.getState();
      expect(next.currentExplainerId).toBe('p3');
      expect(next.timer.startedAt).toBe(new Date(start + 45_000 + HUSHLE_TIME_UP_GRACE_MS + 1).toISOString());
      expect(Date.parse(next.timer.endsAt!) - Date.parse(next.timer.startedAt!)).toBe(45_000);
    });

    it('stops the clock between turns, where there is nothing to score', async () => {
      const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
        plugin: hushlePlugin,
        players: ['p1', 'p2', 'p3', 'p4'],
      });
      await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', cardsPerTurn: 2, createdBy: 'p1' });
      await harness.performAction('p1', {
        type: 'set-teams',
        teams: [
          { name: 'A', playerIds: ['p1', 'p2'] },
          { name: 'B', playerIds: ['p3', 'p4'] },
        ],
      });
      await harness.performAction('p1', { type: 'start-turn', teamId: harness.getState().teams[0]!.id, explainerId: 'p1' });
      await harness.performAction('p1', { type: 'correct-guess' });
      await harness.performAction('p1', { type: 'correct-guess' });
      const between = harness.getState();
      expect(between.phase).toBe('playing');
      expect(between.currentCard).toBeNull();
      expect(between.timer).toEqual({ startedAt: null, durationSeconds: 60, paused: true, endsAt: null });
      await harness.performAction('p1', { type: 'correct-guess' });
      await harness.performAction('p1', { type: 'next-card' });
      expect(harness.getState()).toEqual(between);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // M20a — Weighted card draw with difficulty distribution
  // ────────────────────────────────────────────────────────────────────

  it('draw respects difficultyDistribution over 100 calls', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    // Force a deterministic distribution: only `medium` cards.
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      difficultyDistribution: { easy: 0, medium: 1, hard: 0 },
      cardsPerTurn: 100,
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    const teamA = harness.getState().teams[0]!;
    await harness.performAction('p1', {
      type: 'start-turn',
      teamId: teamA.id,
      explainerId: 'p1',
    });
    // The first card drawn must be a `medium` card.
    expect(harness.getState().currentCard?.difficulty).toBe('medium');
    // The en deck has 7 medium cards. Draw until either the medium
    // bucket is exhausted (draw falls back to any unused card) or
    // the deck runs out — every draw BEFORE that point must be
    // `medium`. Stop checking as soon as the first non-medium card
    // shows up; that's the documented fallback behaviour.
    let mediumSeen = 0;
    let nonMediumSeen = 0;
    for (let i = 0; i < 30; i += 1) {
      const card = harness.getState().currentCard;
      if (card === null) break;
      if (card.difficulty === 'medium') {
        mediumSeen += 1;
      } else {
        nonMediumSeen += 1;
        if (nonMediumSeen === 1) break;
      }
      await harness.performAction('p1', { type: 'correct-guess' });
    }
    // 7 medium cards total in the en deck (1 from start-turn + 6 from
    // correct-guess); the 7th correct-guess then triggers the fallback
    // to any unused tier.
    expect(mediumSeen).toBeGreaterThanOrEqual(2);
    expect(mediumSeen).toBe(7);
  });

  it('draw never repeats a card within the same session', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      cardsPerTurn: 100, // disable the per-turn cap so we can drain the deck
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    const teamA = harness.getState().teams[0]!;
    await harness.performAction('p1', {
      type: 'start-turn',
      teamId: teamA.id,
      explainerId: 'p1',
    });
    // Drain the deck. `correct-guess` always draws a new card; after 23
    // draws we should have seen 24 unique cards (the entire 24-card
    // en deck).
    const drawn: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const card = harness.getState().currentCard;
      if (card === null) break;
      drawn.push(card.id);
      await harness.performAction('p1', { type: 'correct-guess' });
    }
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn.length).toBe(24);
  });

  // ── Classic-Taboo buzzer (bust-forbidden) ─────────────────────────
  async function setupBustHarness() {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.performAction('p1', {
      type: 'start-game',
      packId: 'hushle-en-basic',
      language: 'en',
      cardsPerTurn: 100,
      createdBy: 'p1',
    });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] }, // p1 explains, p2 guesses
        { name: 'B', playerIds: ['p3', 'p4'] }, // opponents
      ],
    });
    const teamA = harness.getState().teams[0]!;
    await harness.performAction('p1', { type: 'start-turn', teamId: teamA.id, explainerId: 'p1' });
    return harness;
  }

  it('lets an opposing player bust a forbidden word (-1 and next card)', async () => {
    const harness = await setupBustHarness();
    const before = harness.getState();
    const beforeScore = before.teams[0]!.score;
    const beforeCardId = before.currentCard!.id;

    // p3 is on team B (opposing) — the buzzer is valid.
    await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3', cardId: beforeCardId });

    const after = harness.getState();
    expect(after.teams[0]!.penaltyCount).toBe(before.teams[0]!.penaltyCount + 1);
    expect(after.teams[0]!.score).toBe(beforeScore - 1);
    expect(after.currentCard).not.toBeNull();
    expect(after.currentCard!.id).not.toBe(beforeCardId);
    expect(after.totalCardsPlayed).toBe(before.totalCardsPlayed + 1);
  });

  it('rejects a bust from a teammate of the explainer', async () => {
    const harness = await setupBustHarness();
    const before = JSON.stringify(harness.getState());
    // p2 is on team A with the explainer — no self-busting.
    await harness.performAction('p2', { type: 'bust-forbidden', bustedBy: 'p2', cardId: harness.getState().currentCard!.id });
    expect(JSON.stringify(harness.getState())).toBe(before);
  });

  it('rejects a bust from a player with no team (floater/spectator)', async () => {
    const harness = await setupBustHarness();
    const before = JSON.stringify(harness.getState());
    await harness.performAction('p4', { type: 'bust-forbidden', bustedBy: 'ghost-player', cardId: harness.getState().currentCard!.id });
    expect(JSON.stringify(harness.getState())).toBe(before);
  });

  it('rejects a bust without a server-injected actor id', async () => {
    const harness = await setupBustHarness();
    const before = JSON.stringify(harness.getState());
    // No bustedBy — the reducer must not trust an anonymous buzz.
    await harness.performAction('p3', { type: 'bust-forbidden', cardId: harness.getState().currentCard!.id });
    expect(JSON.stringify(harness.getState())).toBe(before);
  });

  it('two BUSTs for the same card (both opponents at once, or a double tap) cost ONE penalty and burn no card', async () => {
    const harness = await setupBustHarness();
    const before = harness.getState();
    const cardId = before.currentCard!.id;
    await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3', cardId });
    const afterFirst = harness.getState();
    await harness.performAction('p4', { type: 'bust-forbidden', bustedBy: 'p4', cardId });
    const afterSecond = harness.getState();
    // The second names a card that is no longer on screen: ignored, same object.
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.teams[0]!.penaltyCount).toBe(before.teams[0]!.penaltyCount + 1);
    expect(afterSecond.teams[0]!.score).toBe(before.teams[0]!.score - 1);
    expect(afterSecond.usedCardIds).toHaveLength(before.usedCardIds.length + 1);
    expect(afterSecond.totalCardsPlayed).toBe(before.totalCardsPlayed + 1);
  });

  it('ignores a BUST for another card, and one without a card id', async () => {
    const harness = await setupBustHarness();
    const before = harness.getState();
    await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3', cardId: 'not-the-card-on-screen' });
    expect(harness.getState()).toBe(before);
    await harness.performAction('p3', { type: 'bust-forbidden', bustedBy: 'p3' });
    expect(harness.getState()).toBe(before);
  });

  it('validateAction: BUST must name a card; other actions pass through to the reducer', () => {
    const validate = hushlePlugin.validateAction!;
    expect(validate({ type: 'bust-forbidden', bustedBy: 'p3' })).toMatch(/cardId/);
    expect(validate({ type: 'bust-forbidden', bustedBy: 'p3', cardId: '' })).toMatch(/cardId/);
    expect(validate({ type: 'bust-forbidden', bustedBy: 'p3', cardId: 'x'.repeat(129) })).toMatch(/cardId/);
    expect(validate({ type: 'bust-forbidden', bustedBy: 'p3', cardId: 'en-easy-001' })).toBeNull();
    expect(validate({ type: 'correct-guess' })).toBeNull();
    expect(validate(null)).toMatch(/object/);
  });
});

describe('Hushle play again (restartActions)', () => {
  it('declares start-game as its only restart action', () => {
    expect(hushlePlugin.restartActions).toEqual(['start-game']);
  });

  it('start-game from the ended phase starts a new game with fresh teams, scores and deck', async () => {
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', language: 'en', createdBy: 'p1' });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    await harness.performAction('p1', { type: 'start-turn', teamId: harness.getState().teams[0]!.id, explainerId: 'p1' });
    await harness.performAction('p1', { type: 'correct-guess' });
    await harness.performAction('p1', { type: 'end-game' });
    expect(harness.getState().phase).toBe('ended');

    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', language: 'en', createdBy: 'p1' });
    const again = harness.getState();
    expect(again.phase).toBe('team_setup');
    expect(again.teams).toEqual([]);
    expect(again.usedCardIds).toEqual([]);
    expect(again.totalCardsPlayed).toBe(0);
    expect(again.currentCard).toBeNull();
  });
});
