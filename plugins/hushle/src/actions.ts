/**
 * Hushle action reducer.
 *
 * Every action in this file is host-only (`role: 'host'` in
 * `actionPolicies`). The game is moderated by the host: the host
 * decides when a card is correct/pass/penalty, when the turn ends,
 * and which team/explainer goes next. This keeps the action surface
 * small and the server-authoritative state machine easy to reason
 * about.
 *
 * Timer model: the state records `timer.startedAt` and
 * `timer.durationSeconds`; the client UI runs a local countdown
 * and only round-trips to the server when the host pauses, resumes,
 * or the round ends. This is intentional — a per-second `tick` action
 * would flood the activity dispatch route for no game-state reason.
 *
 * Card draw model (M20a): the reducer samples a difficulty tier from
 * `settings.difficultyDistribution`, then draws the next unused card
 * from that tier's bucket. If that tier is exhausted, falls back to
 * any unused card from any tier. The pure-deck walk (M17) is gone —
 * weighted draw means the host can run a session that's mostly easy
 * (60% / 30% / 10%) without writing a custom plugin.
 */

import { getDefaultDeck, getLanguageForPackSlug } from './decks';
import type {
  HushleAction,
  HushleCard,
  HushleDifficulty,
  HushleLanguage,
  HushleSettings,
  HushleState,
  HushleTeam,
} from './state';
import {
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
  HUSHLE_DEFAULT_TEAM_SIZE,
  HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
} from './state';

function nowIso(): string {
  return new Date().toISOString();
}

function makeTeamId(): string {
  return `team-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * M20a — pick a difficulty tier by sampling the configured
 * distribution. Pure (no RNG state) so the host can run deterministic
 * tests by stubbing `Math.random` in the test harness.
 *
 * Tiers with zero weight are skipped; if every tier has zero weight
 * we fall back to `'easy'` (the column default) so the reducer never
 * fails to draw.
 */
function pickDifficultyTier(
  distribution: Record<HushleDifficulty, number>,
  rng: () => number = Math.random
): HushleDifficulty {
  const order: HushleDifficulty[] = ['easy', 'medium', 'hard'];
  let total = 0;
  for (const tier of order) {
    const w = distribution[tier];
    if (typeof w === 'number' && w > 0) total += w;
  }
  if (total <= 0) return 'easy';
  const r = rng() * total;
  let cursor = 0;
  for (const tier of order) {
    const w = distribution[tier];
    if (typeof w !== 'number' || w <= 0) continue;
    cursor += w;
    if (r < cursor) return tier;
  }
  return 'easy';
}

/**
 * M20a — sample a card respecting `usedCardIds` and the difficulty
 * tier. Returns null when the deck is fully exhausted.
 *
 * Algorithm:
 *  1. Pick a tier from the distribution.
 *  2. Find any card of that tier whose id is not in `usedCardIds`.
 *  3. If none in that tier, fall back to any unused card from any
 *     tier (keeps the game running even if the configured distribution
 *     doesn't match the seeded deck).
 *  4. If every card is used, return null.
 */
function drawNextCardWeighted(
  deck: HushleCard[],
  usedCardIds: string[],
  distribution: Record<HushleDifficulty, number>,
  rng: () => number = Math.random
): HushleCard | null {
  if (deck.length === 0) return null;
  if (usedCardIds.length >= deck.length) return null;
  const used = new Set(usedCardIds);
  const tier = pickDifficultyTier(distribution, rng);
  const tierMatches = deck.filter((c) => c.difficulty === tier && !used.has(c.id));
  if (tierMatches.length > 0) {
    return tierMatches[Math.floor(rng() * tierMatches.length)] ?? null;
  }
  // Fallback: any unused card.
  const unused = deck.filter((c) => !used.has(c.id));
  if (unused.length > 0) {
    return unused[Math.floor(rng() * unused.length)] ?? null;
  }
  return null;
}

function findTeam(state: HushleState, teamId: string): HushleTeam | null {
  return state.teams.find((t) => t.id === teamId) ?? null;
}

function nextTeamIndex(state: HushleState): number {
  if (state.teams.length === 0) return -1;
  const idx = state.teams.findIndex((t) => t.id === state.currentTeamId);
  if (idx === -1) return 0;
  return (idx + 1) % state.teams.length;
}

/**
 * M20a — pick the next explainer for a team. If the team has no
 * regular players left to explain, fall back to the floater (if any).
 * If the team's players list is empty AND there's no floater, returns
 * null (the host UI is expected to surface this as a configuration
 * error rather than crash the reducer).
 *
 * The "rotation" is a flat circular index into the team's playerIds
 * array (or [floater] if the team is empty). The reducer increments
 * `state.currentExplainerIndex` on every turn so the same player
 * doesn't explain twice in a row when teamSize > 1.
 */
function pickExplainerForTeam(state: HushleState, team: HushleTeam): string | null {
  if (team.playerIds.length > 0) {
    const idx = state.currentExplainerIndex % team.playerIds.length;
    return team.playerIds[idx] ?? null;
  }
  if (state.floaterPlayerId) return state.floaterPlayerId;
  return null;
}

function startTurn(state: HushleState, team: HushleTeam, explainerId: string | null): HushleState {
  const explainer = explainerId ?? pickExplainerForTeam(state, team);
  const card = drawNextCardWeighted(
    state.deck,
    state.usedCardIds,
    state.settings.difficultyDistribution
  );
  const usedCardIds = card ? [...state.usedCardIds, card.id] : state.usedCardIds;
  return {
    ...state,
    phase: 'playing',
    currentTeamId: team.id,
    currentExplainerId: explainer,
    currentCard: card,
    usedCardIds,
    cardsPlayedThisTurn: 0,
    timer: {
      startedAt: nowIso(),
      durationSeconds: state.settings.turnDurationSeconds,
      paused: false,
    },
  };
}

function applyCorrectPassPenalty(
  state: HushleState,
  kind: 'correct' | 'pass' | 'penalty'
): HushleState {
  if (state.phase !== 'playing') return state;
  if (!state.currentTeamId) return state;
  const team = findTeam(state, state.currentTeamId);
  if (!team) return state;

  const scoreDelta = kind === 'correct' ? 1 : kind === 'penalty' ? -1 : 0;
  const updatedTeams: HushleTeam[] = state.teams.map((t) => {
    if (t.id !== team.id) return t;
    return {
      ...t,
      score: t.score + scoreDelta,
      correctCount: kind === 'correct' ? t.correctCount + 1 : t.correctCount,
      passCount: kind === 'pass' ? t.passCount + 1 : t.passCount,
      penaltyCount: kind === 'penalty' ? t.penaltyCount + 1 : t.penaltyCount,
    };
  });

  const card = drawNextCardWeighted(
    state.deck,
    state.usedCardIds,
    state.settings.difficultyDistribution
  );
  const usedCardIds = card ? [...state.usedCardIds, card.id] : state.usedCardIds;
  const cardsPlayedThisTurn = state.cardsPlayedThisTurn + 1;

  // If we've hit the per-turn cap or the deck is exhausted, the turn
  // ends and the next team takes over.
  const deckExhausted = card === null;
  const turnExhausted = cardsPlayedThisTurn >= state.settings.cardsPerTurn || deckExhausted;

  if (turnExhausted) {
    const nextIdx = nextTeamIndex({ ...state, teams: updatedTeams });
    const nextTeam = nextIdx >= 0 ? updatedTeams[nextIdx] ?? null : null;
    if (!nextTeam) {
      return {
        ...state,
        teams: updatedTeams,
        currentCard: null,
        usedCardIds,
        totalCardsPlayed: state.totalCardsPlayed + 1,
        phase: 'ended',
        timer: { startedAt: null, durationSeconds: state.settings.turnDurationSeconds, paused: true },
      };
    }
    return {
      ...state,
      teams: updatedTeams,
      currentCard: null,
      usedCardIds,
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: state.totalCardsPlayed + 1,
      // Caller (host UI) is expected to call `start-turn` with the
      // explicit team + explainer. We hand back a "between_turns"
      // state by clearing the active card but staying in `playing`
      // so the next `start-turn` can pick the explainer.
      timer: { startedAt: null, durationSeconds: state.settings.turnDurationSeconds, paused: true },
    };
  }

  return {
    ...state,
    teams: updatedTeams,
    currentCard: card,
    usedCardIds,
    cardsPlayedThisTurn,
    totalCardsPlayed: state.totalCardsPlayed + 1,
    timer: {
      startedAt: nowIso(),
      durationSeconds: state.settings.turnDurationSeconds,
      paused: false,
    },
  };
}

export function hushleReducer(state: HushleState, action: HushleAction): HushleState {
  switch (action.type) {
    case 'start-game': {
      // Resolve language from the packId slug. M18 only ships the two
      // built-in packs; custom packs (M19+) will need a richer resolver
      // that hits the `card_packs` table. The reducer stays pure, so
      // for now the host sends `language` alongside the packId and the
      // reducer uses whichever is consistent — packId wins when its
      // built-in language is known, otherwise we fall back to language.
      const fromSlug = getLanguageForPackSlug(action.packId);
      const language: HushleLanguage = fromSlug ?? action.language ?? 'en';
      const requestedTeamSize =
        typeof action.teamSize === 'number' && action.teamSize > 0
          ? Math.min(Math.floor(action.teamSize), 16)
          : HUSHLE_DEFAULT_TEAM_SIZE;
      // Normalize the difficulty distribution: reject negative weights,
      // fill missing tiers with 0, renormalize so it sums to 1. If
      // every tier is zero we keep the default distribution so the
      // game still draws cards.
      const requestedDistribution = action.difficultyDistribution ?? {};
      const distribution: Record<HushleDifficulty, number> = {
        easy: Math.max(0, requestedDistribution.easy ?? 0),
        medium: Math.max(0, requestedDistribution.medium ?? 0),
        hard: Math.max(0, requestedDistribution.hard ?? 0),
      };
      const sum = distribution.easy + distribution.medium + distribution.hard;
      const normalizedDistribution =
        sum > 0
          ? {
              easy: distribution.easy / sum,
              medium: distribution.medium / sum,
              hard: distribution.hard / sum,
            }
          : { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION };
      const settings: HushleSettings = {
        turnDurationSeconds:
          typeof action.turnDurationSeconds === 'number' && action.turnDurationSeconds > 0
            ? Math.min(action.turnDurationSeconds, 300)
            : HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
        cardsPerTurn:
          typeof action.cardsPerTurn === 'number' && action.cardsPerTurn > 0
            ? Math.min(Math.floor(action.cardsPerTurn), 100)
            : state.settings.cardsPerTurn,
        language,
        packId: action.packId,
        teamSize: requestedTeamSize,
        difficultyDistribution: normalizedDistribution,
      };
      const deck = action.deck && action.deck.length > 0
        ? action.deck.map((card) => ({ ...card, forbiddenWords: [...card.forbiddenWords] }))
        : getDefaultDeck(language);
      return {
        ...state,
        phase: 'team_setup',
        teams: [],
        floaterPlayerId: null,
        currentExplainerIndex: 0,
        currentTeamId: null,
        currentExplainerId: null,
        currentCard: null,
        deck,
        deckIndex: 0,
        usedCardIds: [],
        settings,
        timer: {
          startedAt: null,
          durationSeconds: settings.turnDurationSeconds,
          paused: true,
        },
        cardsPlayedThisTurn: 0,
        totalCardsPlayed: 0,
        createdBy: action.createdBy,
        createdAt: nowIso(),
      };
    }

    case 'set-teams': {
      if (state.phase !== 'lobby' && state.phase !== 'team_setup') return state;
      const teamSize = state.settings.teamSize;
      // Validate the floater against the un-trimmed input. We trim
      // teams to `teamSize` *after* the floater check, otherwise
      // trimming drops the floater off a team first and we'd
      // validate against a falsified player list.
      const floater = action.floaterPlayerId ?? null;
      const allRequestedPlayers = new Set<string>();
      for (const t of action.teams) for (const id of t.playerIds) allRequestedPlayers.add(id);
      const validatedFloater = floater && !allRequestedPlayers.has(floater) ? floater : null;
      const teams: HushleTeam[] = action.teams
        .filter((t) => t.name.trim().length > 0)
        .map((t) => ({
          id: makeTeamId(),
          name: t.name.trim().slice(0, 40),
          // Trim each team to `teamSize` players. The host UI is
          // expected to surface "too many players" as a separate
          // validation error before dispatch; the reducer is the
          // last line of defence.
          playerIds: t.playerIds.slice(0, Math.max(1, teamSize)),
          score: 0,
          correctCount: 0,
          passCount: 0,
          penaltyCount: 0,
        }));
      return {
        ...state,
        teams,
        floaterPlayerId: validatedFloater,
        currentExplainerIndex: 0,
        phase: 'team_setup',
      };
    }

    case 'start-turn': {
      if (state.phase !== 'team_setup' && state.phase !== 'playing' && state.phase !== 'ended') {
        return state;
      }
      if (state.phase === 'ended') return state;
      const team = findTeam(state, action.teamId);
      if (!team) return state;
      return startTurn(state, team, action.explainerId);
    }

    case 'set-explainer': {
      if (state.phase !== 'playing' && state.phase !== 'team_setup') return state;
      return { ...state, currentExplainerId: action.explainerId };
    }

    case 'next-card': {
      if (state.phase !== 'playing') return state;
      const card = drawNextCardWeighted(
        state.deck,
        state.usedCardIds,
        state.settings.difficultyDistribution
      );
      if (card === null) return state;
      return {
        ...state,
        currentCard: card,
        usedCardIds: [...state.usedCardIds, card.id],
        cardsPlayedThisTurn: state.cardsPlayedThisTurn + 1,
        timer: {
          startedAt: nowIso(),
          durationSeconds: state.settings.turnDurationSeconds,
          paused: false,
        },
      };
    }

    case 'correct-guess':
      return applyCorrectPassPenalty(state, 'correct');

    case 'pass':
      return applyCorrectPassPenalty(state, 'pass');

    case 'penalty':
      return applyCorrectPassPenalty(state, 'penalty');

    case 'end-turn': {
      if (state.phase !== 'playing') return state;
      const idx = nextTeamIndex(state);
      if (idx < 0) {
        return { ...state, phase: 'ended', currentCard: null };
      }
      const nextTeam = state.teams[idx];
      if (!nextTeam) {
        return { ...state, phase: 'ended', currentCard: null };
      }
      // M20a — advance the rotation index so the same player doesn't
      // explain two turns in a row. For odd-player games with a
      // floater, the floater alternates teams across turns because
      // `nextTeamIndex` swaps teams while `pickExplainerForTeam`
      // returns the floater when the next team has empty `playerIds`.
      const nextExplainerIndex = state.currentExplainerIndex + 1;
      return startTurn(
        { ...state, currentExplainerIndex: nextExplainerIndex },
        nextTeam,
        null
      );
    }

    case 'end-game':
      return {
        ...state,
        phase: 'ended',
        currentCard: null,
        currentExplainerId: null,
        timer: { startedAt: null, durationSeconds: state.settings.turnDurationSeconds, paused: true },
      };

    default:
      return state;
  }
}

/**
 * M20a — pure helper exported so the host UI (and tests) can ask
 * "who explains next on team X" without re-implementing the rotation.
 * Mirrors `pickExplainerForTeam` but reads from a snapshot, not
 * mutable state, so React components can use it safely.
 */
export function hushleNextExplainerForTeam(
  state: Pick<HushleState, 'currentExplainerIndex' | 'floaterPlayerId'>,
  team: Pick<HushleTeam, 'playerIds'>
): string | null {
  return pickExplainerForTeam(
    state as HushleState,
    team as HushleTeam
  );
}
