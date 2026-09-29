/**
 * Hushle action reducer.
 *
 * The host moderates the game (`role: 'host'` in `actionPolicies`): the
 * host decides when a card is correct / skipped / penalised, when the turn
 * ends, and when the game ends. The one player action is `bust-forbidden`,
 * the other team's buzzer. The reducer is pure apart from reading the
 * clock, and defensive: an action that does not fit the phase returns the
 * state unchanged.
 *
 * Turns: teams play in seat order. Each team has its own explainer
 * rotation (see `rotation.ts`) — its players in turn, plus the floater's
 * slot when the player count is odd — so every player explains in turn.
 *
 * Timer model: a turn has ONE clock. The turn's start sets
 * `timer.startedAt` and the deadline `timer.endsAt`; scoring a card does
 * not restart it, so the explaining team has the whole duration for as
 * many cards as they manage. Once the deadline (plus a short grace for a
 * last-second tap in flight) has passed, the turn's scoring is over: the
 * reducer refuses further cards until the host starts the next turn.
 * There is no per-second tick — every client counts down to `endsAt`.
 *
 * Card draw model (M20a): the reducer samples a difficulty tier from
 * `settings.difficultyDistribution`, then draws the next unused card
 * from that tier's bucket. If that tier is exhausted, falls back to
 * any unused card from any tier.
 */

import { getDefaultDeck, getLanguageForPackSlug } from './decks';
import { cursorAfter, explainerQueue, nextExplainer } from './rotation';
import type {
  HushleAction,
  HushleCard,
  HushleDifficulty,
  HushleLanguage,
  HushleSettings,
  HushleState,
  HushleTeam,
  HushleTimer,
} from './state';
import {
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
  HUSHLE_DEFAULT_TEAM_SIZE,
  HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
  HUSHLE_TIME_UP_GRACE_MS,
} from './state';

function nowMs(): number {
  return Date.now();
}

function makeTeamId(): string {
  return `team-${Math.random().toString(36).slice(2, 10)}`;
}

/** A stopped clock: between turns, before play, after the game. */
function stoppedTimer(settings: HushleSettings): HushleTimer {
  return { startedAt: null, durationSeconds: settings.turnDurationSeconds, paused: true, endsAt: null };
}

/**
 * True once the running turn's time is up: its deadline plus the grace
 * for a tap already on its way has passed.
 */
function turnTimeIsUp(state: HushleState, now: number): boolean {
  if (!state.timer.startedAt || !state.timer.endsAt) return false;
  const deadline = Date.parse(state.timer.endsAt);
  return Number.isFinite(deadline) && now > deadline + HUSHLE_TIME_UP_GRACE_MS;
}

/**
 * M20a — pick a difficulty tier by sampling the configured
 * distribution. Tiers with zero weight are skipped; if every tier has zero
 * weight we fall back to `'easy'` so the reducer never fails to draw.
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

/** The teams with one team's rotation cursor moved, when there is somewhere to move it. */
function withCursor(teams: HushleTeam[], teamIndex: number, cursor: number | null): HushleTeam[] {
  if (cursor === null) return teams;
  return teams.map((team, i) => (i === teamIndex ? { ...team, nextExplainerSlot: cursor } : team));
}

/**
 * Start a turn for `team`. The explainer is the one the host named, or
 * the next in the team's rotation; either way the team's rotation then
 * continues after them. The turn's clock starts now.
 */
function startTurn(state: HushleState, team: HushleTeam, requestedExplainer: string | null): HushleState {
  const teamIndex = state.teams.findIndex((t) => t.id === team.id);
  const explainer = requestedExplainer ?? nextExplainer(state, teamIndex).explainerId;
  const teams = withCursor(state.teams, teamIndex, cursorAfter(state, teamIndex, explainer));
  const card = drawNextCardWeighted(
    state.deck,
    state.usedCardIds,
    state.settings.difficultyDistribution
  );
  const usedCardIds = card ? [...state.usedCardIds, card.id] : state.usedCardIds;
  const start = nowMs();
  const duration = state.settings.turnDurationSeconds;
  return {
    ...state,
    teams,
    phase: 'playing',
    turnNumber: state.turnNumber + 1,
    currentTeamId: team.id,
    currentExplainerId: explainer,
    currentCard: card,
    usedCardIds,
    cardsPlayedThisTurn: 0,
    timer: {
      startedAt: new Date(start).toISOString(),
      durationSeconds: duration,
      paused: false,
      endsAt: new Date(start + duration * 1000).toISOString(),
    },
  };
}

function applyCorrectPassPenalty(
  state: HushleState,
  kind: 'correct' | 'pass' | 'penalty'
): HushleState {
  if (state.phase !== 'playing') return state;
  if (!state.currentTeamId) return state;
  // Between turns there is no card to score.
  if (!state.timer.startedAt) return state;
  // Time's up: the turn's scoring is over.
  if (turnTimeIsUp(state, nowMs())) return state;
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
        timer: stoppedTimer(state.settings),
      };
    }
    // Between turns: the card and the clock are cleared but the phase
    // stays `playing`; `end-turn` starts the next team's turn.
    return {
      ...state,
      teams: updatedTeams,
      currentCard: null,
      usedCardIds,
      cardsPlayedThisTurn: 0,
      totalCardsPlayed: state.totalCardsPlayed + 1,
      timer: stoppedTimer(state.settings),
    };
  }

  // The turn goes on with the next card — on the same clock.
  return {
    ...state,
    teams: updatedTeams,
    currentCard: card,
    usedCardIds,
    cardsPlayedThisTurn,
    totalCardsPlayed: state.totalCardsPlayed + 1,
  };
}

export function hushleReducer(state: HushleState, action: HushleAction): HushleState {
  switch (action.type) {
    case 'start-game': {
      // Resolve language from the packId slug: packId wins when its
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
        turnNumber: 0,
        currentTeamId: null,
        currentExplainerId: null,
        currentCard: null,
        deck,
        deckIndex: 0,
        usedCardIds: [],
        settings,
        timer: stoppedTimer(settings),
        cardsPlayedThisTurn: 0,
        totalCardsPlayed: 0,
        createdBy: action.createdBy,
        createdAt: new Date(nowMs()).toISOString(),
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
      for (const t of action.teams) {
        for (const id of t.playerIds) {
          // A player on two teams would see every card while guessing:
          // refuse the whole seating rather than guess which team was meant.
          if (allRequestedPlayers.has(id)) return state;
          allRequestedPlayers.add(id);
        }
      }
      const validatedFloater = floater && !allRequestedPlayers.has(floater) ? floater : null;
      const teams: HushleTeam[] = action.teams
        .filter((t) => t.name.trim().length > 0)
        .map((t) => ({
          id: makeTeamId(),
          name: t.name.trim().slice(0, 40),
          // Trim each team to `teamSize` players. The host UI offers only
          // teams with room; the reducer is the last line of defence.
          playerIds: t.playerIds.slice(0, Math.max(1, teamSize)),
          score: 0,
          correctCount: 0,
          passCount: 0,
          penaltyCount: 0,
          nextExplainerSlot: 0,
        }));
      return {
        ...state,
        teams,
        floaterPlayerId: validatedFloater,
        turnNumber: 0,
        phase: 'team_setup',
      };
    }

    case 'start-turn': {
      if (state.phase !== 'team_setup' && state.phase !== 'playing') return state;
      const team = findTeam(state, action.teamId);
      if (!team) return state;
      return startTurn(state, team, action.explainerId);
    }

    case 'set-explainer': {
      if (state.phase !== 'playing' && state.phase !== 'team_setup') return state;
      // The host hands the turn to someone else; the team's rotation then
      // continues after whoever explains now.
      const teamIndex = state.teams.findIndex((t) => t.id === state.currentTeamId);
      const teams =
        state.phase === 'playing' && teamIndex !== -1
          ? withCursor(state.teams, teamIndex, cursorAfter(state, teamIndex, action.explainerId))
          : state.teams;
      return { ...state, teams, currentExplainerId: action.explainerId };
    }

    case 'next-card': {
      if (state.phase !== 'playing') return state;
      if (!state.timer.startedAt) return state;
      if (turnTimeIsUp(state, nowMs())) return state;
      const card = drawNextCardWeighted(
        state.deck,
        state.usedCardIds,
        state.settings.difficultyDistribution
      );
      if (card === null) return state;
      // A swapped card counts toward the turn's cards but not the score,
      // and the turn's clock keeps running.
      return {
        ...state,
        currentCard: card,
        usedCardIds: [...state.usedCardIds, card.id],
        cardsPlayedThisTurn: state.cardsPlayedThisTurn + 1,
      };
    }

    case 'correct-guess':
      return applyCorrectPassPenalty(state, 'correct');

    case 'pass':
      return applyCorrectPassPenalty(state, 'pass');

    case 'penalty':
      return applyCorrectPassPenalty(state, 'penalty');

    case 'bust-forbidden': {
      // Classic-Taboo buzzer. Server-authoritative actor check: the
      // bustedBy id is injected by the host from the authenticated
      // session (never trusted from the wire), and the reducer only
      // accepts it when that player sits on a team OTHER than the
      // explaining team. Teammates and the floater cannot bust.
      if (state.phase !== 'playing') return state;
      if (!state.currentCard) return state;
      if (!state.currentTeamId) return state;
      const bustedBy = action.bustedBy;
      if (typeof bustedBy !== 'string' || bustedBy.length === 0) return state;
      const busterTeam = state.teams.find((t) => t.playerIds.includes(bustedBy));
      if (!busterTeam) return state;
      if (busterTeam.id === state.currentTeamId) return state;
      return applyCorrectPassPenalty(state, 'penalty');
    }

    case 'end-turn': {
      if (state.phase !== 'playing') return state;
      const idx = nextTeamIndex(state);
      const nextTeam = idx >= 0 ? state.teams[idx] : undefined;
      if (!nextTeam) {
        return { ...state, phase: 'ended', currentCard: null, timer: stoppedTimer(state.settings) };
      }
      // The next team's turn starts at once, with the next player in its
      // own rotation explaining.
      return startTurn(state, nextTeam, null);
    }

    case 'end-game':
      return {
        ...state,
        phase: 'ended',
        currentCard: null,
        currentExplainerId: null,
        timer: stoppedTimer(state.settings),
      };

    default:
      return state;
  }
}

/**
 * The explainer rotation of a team, in the order its turns go: its players,
 * plus the floater's slot when there is one. Exported so the panel (and
 * tests) read the same rotation the reducer uses.
 */
export function hushleExplainerQueue(
  state: Pick<HushleState, 'teams' | 'floaterPlayerId'>,
  teamId: string
): string[] {
  return explainerQueue(
    state,
    state.teams.findIndex((team) => team.id === teamId)
  );
}

/** Who explains the team's NEXT turn, if the host leaves it to the rotation. */
export function hushleNextExplainerForTeam(
  state: Pick<HushleState, 'teams' | 'floaterPlayerId'>,
  teamId: string
): string | null {
  return nextExplainer(
    state,
    state.teams.findIndex((team) => team.id === teamId)
  ).explainerId;
}
