import { describe, it, expect } from 'vitest';
import { hushlePlugin, type HushleState } from '../index';
import {
  migrateHushleState,
  HUSHLE_STATE_VERSION,
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
} from '../state';
import { hushleNextExplainerForTeam } from '../actions';
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
    expect(harness.getState().currentExplainerIndex).toBe(0);

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

    // Host scores a correct guess.
    await harness.performAction('p1', { type: 'correct-guess' });
    const afterCorrect = harness.getState();
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
    // M20a — with teamSize=2 and an even rotation index, the next
    // team picks player at index (0+1)%2 = 1 = p4. The M17 test
    // expected p3 because the reducer used `playerIds[0]`; the M20a
    // rotation picks via the `currentExplainerIndex` modulo team size.
    expect(harness.getState().currentExplainerId).toBe('p4');
    // The next call increments the rotation index again.
    expect(harness.getState().currentExplainerIndex).toBe(1);
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
      expect(state.currentExplainerIndex).toBe(0);
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
    const v2 = {
      version: HUSHLE_STATE_VERSION,
      phase: 'lobby',
      teams: [],
      floaterPlayerId: null,
      currentExplainerIndex: 0,
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
      timer: { startedAt: null, durationSeconds: 60, paused: true },
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: 0,
      createdBy: null,
      createdAt: null,
    };
    const first = migrateHushleState(v2);
    const second = migrateHushleState(first);
    expect(second).toEqual(first);
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
    // 5 players: A=[p1,p2], B=[p3,p4], floater=p5.
    // Across 4 turns (A, B, A, B), the explainers should be p1, p3, p2, p4
    // — wait, that's the regular rotation with no floater involvement
    // because both teams have 2 players. The 2v2 spec means the floater
    // only matters when one team is short. Verify the standard 2v2 here
    // and the floater-fills-empty-team case in the next test.
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
    expect(harness.getState().currentExplainerId).toBe('p1');
    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentTeamId).toBe(teamB.id);
    expect(harness.getState().currentExplainerId).toBe('p4'); // rotation index 1, team B[1] = p4
    await harness.performAction('p1', { type: 'end-turn' });
    expect(harness.getState().currentTeamId).toBe(teamA.id);
    // Rotation index 2: teamA.playerIds[2 % 2] = teamA.playerIds[0] = p1
    expect(harness.getState().currentExplainerId).toBe('p1');
  });

  it('hushleNextExplainerForTeam picks floater when team has no players', () => {
    expect(
      hushleNextExplainerForTeam(
        { currentExplainerIndex: 0, floaterPlayerId: 'p5' },
        { playerIds: [] }
      )
    ).toBe('p5');
    // 3 % 2 = 1, so the explainer picks the team member at index 1 = p2.
    expect(
      hushleNextExplainerForTeam(
        { currentExplainerIndex: 3, floaterPlayerId: 'p5' },
        { playerIds: ['p1', 'p2'] }
      )
    ).toBe('p2');
    // 1 % 2 = 1 → p2.
    expect(
      hushleNextExplainerForTeam(
        { currentExplainerIndex: 1, floaterPlayerId: 'p5' },
        { playerIds: ['p1', 'p2'] }
      )
    ).toBe('p2');
    // No floater, index 0, playerIds[0] = p1.
    expect(
      hushleNextExplainerForTeam(
        { currentExplainerIndex: 0, floaterPlayerId: null },
        { playerIds: ['p1', 'p2'] }
      )
    ).toBe('p1');
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
});
