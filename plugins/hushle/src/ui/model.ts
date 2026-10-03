/**
 * Hushle panel — the pure half of the view.
 *
 * Everything the panel derives from a state snapshot lives here, free of
 * React, so it can be tested without a DOM: who the viewer is this turn,
 * the countdown's deadline, who explains next, the standings, the
 * settings the host can pick and the actions the panel dispatches.
 *
 * Nothing here changes a rule. The reducer (`../actions.ts`) and the
 * server's per-viewer projection (`@lobbyforge/core`) decide what happens
 * and who sees what; these helpers only read the result.
 */

import { hushleExplainerQueue, hushleNextExplainerForTeam } from '../actions';
import { secureRandom } from '../random';
import type {
  HushleAction,
  HushleCard,
  HushleDifficulty,
  HushleSettings,
  HushleState,
  HushleTeam,
  HushleTimer,
} from '../state';
import {
  HUSHLE_DEFAULT_CARDS_PER_TURN,
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
  HUSHLE_DEFAULT_TEAM_SIZE,
  HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
} from '../state';

/**
 * The state as the panel receives it: the reducer's output AFTER the
 * server's per-viewer projection. The projection never sends the deck or
 * the used card ids — it sends counts instead — and blanks `currentCard`
 * for anyone who must not see it.
 */
export interface HushleViewState extends HushleState {
  /** Cards in the whole deck. */
  deckSize?: number;
  /** Cards not drawn yet. */
  cardsRemaining?: number;
  /** Cards drawn so far. */
  usedCardCount?: number;
}

export interface PanelPlayer {
  userId: string;
  name?: string | null;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** What the viewer does during a turn. */
export type PlayRole = 'explainer' | 'guesser' | 'opponent' | 'floater' | 'spectator';

export function teamOf(state: Pick<HushleState, 'teams'>, userId: string): HushleTeam | null {
  return state.teams.find((team) => team.playerIds.includes(userId)) ?? null;
}

export function teamById(state: Pick<HushleState, 'teams'>, teamId: string | null): HushleTeam | null {
  if (!teamId) return null;
  return state.teams.find((team) => team.id === teamId) ?? null;
}

/**
 * Classic Taboo roles, the same split the server's projection makes: the
 * explainer and the OTHER teams see the card, the explainer's teammates
 * guess blind, and the floater and spectators only watch.
 */
export function playRole(
  state: Pick<HushleState, 'teams' | 'currentTeamId' | 'currentExplainerId' | 'floaterPlayerId'>,
  userId: string
): PlayRole {
  if (state.currentExplainerId && state.currentExplainerId === userId) return 'explainer';
  const team = teamOf(state, userId);
  if (team) {
    return state.currentTeamId && team.id !== state.currentTeamId ? 'opponent' : 'guesser';
  }
  if (state.floaterPlayerId && state.floaterPlayerId === userId) return 'floater';
  return 'spectator';
}

/** The display name the host knows for a user, or null when it has none. */
export function knownName(players: PanelPlayer[], userId: string): string | null {
  const name = players.find((player) => player.userId === userId)?.name?.trim();
  return name ? name : null;
}

// ---------------------------------------------------------------------------
// Turn and timer
// ---------------------------------------------------------------------------

/**
 * A turn's clock is running while the reducer's timer has a start. Between
 * turns (the per-turn card cap was reached) the phase stays `playing` but
 * the timer is cleared — the same signal for every viewer, whatever the
 * projection hid. A running clock can still be past its deadline: then
 * the turn's scoring is over (see `turnDeadline`).
 */
export function isTurnRunning(state: Pick<HushleState, 'phase' | 'timer'>): boolean {
  return state.phase === 'playing' && Boolean(state.timer?.startedAt);
}

/**
 * When the turn's time is up (epoch ms), or null when nothing counts down.
 * The deadline is in state (`timer.endsAt`), so every client counts down
 * to the same moment; a timer without one counts from its start.
 */
export function turnDeadline(timer: HushleTimer | null | undefined): number | null {
  if (!timer || timer.paused || !timer.startedAt) return null;
  const end = timer.endsAt ? Date.parse(timer.endsAt) : Number.NaN;
  if (Number.isFinite(end)) return end;
  const start = Date.parse(timer.startedAt);
  if (!Number.isFinite(start)) return null;
  return start + Math.max(0, timer.durationSeconds) * 1000;
}

/** "Turn 3" — the reducer counts the turns. */
export function turnNumber(state: Pick<HushleState, 'turnNumber'>): number {
  return Math.max(1, state.turnNumber || 0);
}

/**
 * Who `end-turn` will hand the next turn to: the next team in order, and
 * the next player in that team's own rotation — read from the reducer's
 * rotation, so the preview cannot disagree with what happens.
 */
export function nextTurnPreview(
  state: Pick<HushleState, 'teams' | 'currentTeamId' | 'floaterPlayerId'>
): { team: HushleTeam; explainerId: string | null } | null {
  if (state.teams.length === 0) return null;
  const index = state.teams.findIndex((team) => team.id === state.currentTeamId);
  const team = state.teams[index === -1 ? 0 : (index + 1) % state.teams.length];
  if (!team) return null;
  return { team, explainerId: hushleNextExplainerForTeam(state, team.id) };
}

/**
 * Players the host may hand the current turn to: the explaining team's
 * rotation — its players and, with an odd count, the floater.
 */
export function explainerCandidates(
  state: Pick<HushleState, 'teams' | 'currentTeamId' | 'floaterPlayerId'>
): string[] {
  return state.currentTeamId ? hushleExplainerQueue(state, state.currentTeamId) : [];
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** Teams by score (ties keep their order) and every team sharing the top score. */
export function standings(teams: HushleTeam[]): { ranked: HushleTeam[]; leaders: HushleTeam[] } {
  const ranked = teams
    .map((team, index) => ({ team, index }))
    .sort((a, b) => b.team.score - a.team.score || a.index - b.index)
    .map((entry) => entry.team);
  const top = ranked[0];
  const leaders = top ? ranked.filter((team) => team.score === top.score) : [];
  return { ranked, leaders };
}

export interface GameTotals {
  played: number;
  guessed: number;
  skipped: number;
  busted: number;
}

export function gameTotals(state: Pick<HushleState, 'teams' | 'totalCardsPlayed'>): GameTotals {
  let guessed = 0;
  let skipped = 0;
  let busted = 0;
  for (const team of state.teams) {
    guessed += team.correctCount;
    skipped += team.passCount;
    busted += team.penaltyCount;
  }
  return { played: state.totalCardsPlayed, guessed, skipped, busted };
}

// ---------------------------------------------------------------------------
// Settings the host picks in the lobby — the options `start-game` already takes
// ---------------------------------------------------------------------------

export const TURN_TIMER_OPTIONS = [30, 45, 60, 90, 120] as const;
export const CARDS_PER_TURN_OPTIONS = [5, 10, 15, 20] as const;
export const TEAM_SIZE_OPTIONS = [2, 3, 4, 5, 6] as const;

export type DifficultyPreset = 'easier' | 'mixed' | 'harder';

/**
 * Three ready-made weightings of `difficultyDistribution`. `mixed` is the
 * reducer's default (60 / 30 / 10); the reducer renormalises whatever it
 * is sent, so these only need to be proportions.
 */
export const DIFFICULTY_PRESETS: Record<DifficultyPreset, Record<HushleDifficulty, number>> = {
  easier: { easy: 0.8, medium: 0.2, hard: 0 },
  mixed: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
  harder: { easy: 0.2, medium: 0.4, hard: 0.4 },
};

export const DIFFICULTY_PRESET_ORDER: DifficultyPreset[] = ['easier', 'mixed', 'harder'];

/** The preset a distribution matches, or null for a custom one. */
export function presetFor(distribution: Record<HushleDifficulty, number> | null | undefined): DifficultyPreset | null {
  if (!distribution) return null;
  for (const preset of DIFFICULTY_PRESET_ORDER) {
    const weights = DIFFICULTY_PRESETS[preset];
    const same = (['easy', 'medium', 'hard'] as const).every(
      (tier) => Math.abs((distribution[tier] ?? 0) - weights[tier]) < 0.005
    );
    if (same) return preset;
  }
  return null;
}

/** Whole percentages for a distribution, for "60% easy · 30% medium · 10% hard". */
export function percentages(distribution: Record<HushleDifficulty, number>): Record<HushleDifficulty, number> {
  const total = (distribution.easy ?? 0) + (distribution.medium ?? 0) + (distribution.hard ?? 0);
  const share = (tier: HushleDifficulty) => (total > 0 ? Math.round(((distribution[tier] ?? 0) / total) * 100) : 0);
  return { easy: share('easy'), medium: share('medium'), hard: share('hard') };
}

export interface GameSetup {
  packId: string;
  language: string;
  turnDurationSeconds: number;
  cardsPerTurn: number;
  teamSize: number;
  difficultyDistribution: Record<HushleDifficulty, number>;
}

export const DEFAULT_SETUP: Omit<GameSetup, 'packId' | 'language'> = {
  turnDurationSeconds: HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
  cardsPerTurn: HUSHLE_DEFAULT_CARDS_PER_TURN,
  teamSize: HUSHLE_DEFAULT_TEAM_SIZE,
  difficultyDistribution: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
};

/** Built-in pack slugs, used when the host could not list the server's packs. */
export const FALLBACK_PACK_BY_LANGUAGE: Record<'en' | 'tr', string> = {
  en: 'hushle-en-basic',
  tr: 'hushle-tr-basic',
};

export function startGameAction(setup: GameSetup, createdBy: string): HushleAction {
  return {
    type: 'start-game',
    packId: setup.packId,
    language: setup.language,
    turnDurationSeconds: setup.turnDurationSeconds,
    cardsPerTurn: setup.cardsPerTurn,
    teamSize: setup.teamSize,
    difficultyDistribution: { ...setup.difficultyDistribution },
    createdBy,
  };
}

/** The settings of the game that just ended — "New game" keeps them. */
export function setupFromSettings(settings: HushleSettings): GameSetup {
  return {
    packId: settings.packId ?? FALLBACK_PACK_BY_LANGUAGE.en,
    language: settings.language,
    turnDurationSeconds: settings.turnDurationSeconds,
    cardsPerTurn: settings.cardsPerTurn,
    teamSize: settings.teamSize,
    difficultyDistribution: { ...settings.difficultyDistribution },
  };
}

// ---------------------------------------------------------------------------
// Teams — `set-teams` replaces the whole roster, so every edit sends it all
// ---------------------------------------------------------------------------

export interface TeamDraft {
  name: string;
  playerIds: string[];
}

/**
 * Two teams from the people in the room, shuffled: as many as fit, up to
 * `teamSize` each and never one more on one side than the other. One
 * person left over becomes the floater (an odd count); anyone beyond that
 * waits on the bench. `random` is injectable so tests can pin the shuffle.
 */
export function splitIntoTeams(
  playerIds: string[],
  teamSize: number,
  names: [string, string],
  random: () => number = secureRandom
): { teams: TeamDraft[]; floaterPlayerId: string | null } {
  const pool = [...new Set(playerIds)];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const seats = Math.min(Math.max(1, Math.floor(teamSize)), Math.floor(pool.length / 2));
  return {
    teams: [
      { name: names[0], playerIds: pool.slice(0, seats) },
      { name: names[1], playerIds: pool.slice(seats, seats * 2) },
    ],
    floaterPlayerId: pool[seats * 2] ?? null,
  };
}

export function draftOf(teams: HushleTeam[]): TeamDraft[] {
  return teams.map((team) => ({ name: team.name, playerIds: [...team.playerIds] }));
}

/**
 * `set-teams` for a roster. The floater rides along when there is one, so
 * editing a team does not silently drop them; without one the payload is
 * exactly the classic `{ type, teams }`.
 */
export function setTeamsAction(teams: TeamDraft[], floaterPlayerId: string | null): HushleAction {
  return floaterPlayerId
    ? { type: 'set-teams', teams, floaterPlayerId }
    : { type: 'set-teams', teams };
}

/** Every user id already on a team or floating. */
export function seatedIds(state: Pick<HushleState, 'teams' | 'floaterPlayerId'>): Set<string> {
  const ids = new Set<string>();
  for (const team of state.teams) for (const id of team.playerIds) ids.add(id);
  if (state.floaterPlayerId) ids.add(state.floaterPlayerId);
  return ids;
}

export function withPlayerAdded(teams: HushleTeam[], teamId: string, userId: string): TeamDraft[] {
  return teams.map((team) => ({
    name: team.name,
    playerIds: team.id === teamId && !team.playerIds.includes(userId) ? [...team.playerIds, userId] : [...team.playerIds],
  }));
}

export function withPlayerRemoved(teams: HushleTeam[], userId: string): TeamDraft[] {
  return teams.map((team) => ({ name: team.name, playerIds: team.playerIds.filter((id) => id !== userId) }));
}

export function withoutTeam(teams: HushleTeam[], teamId: string): TeamDraft[] {
  return draftOf(teams.filter((team) => team.id !== teamId));
}

// ---------------------------------------------------------------------------
// "This turn" — what happened to each card, as this viewer saw it
// ---------------------------------------------------------------------------

/**
 * The reducer keeps totals, not a history, so the panel keeps its own
 * short log by comparing each snapshot with the one before: a counter of
 * the explaining team moved (got it / skipped / bust — a host penalty and
 * an opponent's bust are the same event), or a card was replaced without
 * scoring (`next-card`). Words are only known to viewers who saw the card;
 * everyone else gets the outcome alone. The log lives in the viewer's
 * browser: a reload starts it afresh, and the reducer's totals stay the
 * source of truth.
 */
export type TurnOutcome = 'correct' | 'pass' | 'penalty' | 'next';

export interface TurnLogEntry {
  key: number;
  outcome: TurnOutcome;
  word: string | null;
  language: string | null;
}

export interface TurnLog {
  entries: TurnLogEntry[];
  /** Increments per entry, so React keys stay unique across turns. */
  seq: number;
}

export const EMPTY_TURN_LOG: TurnLog = { entries: [], seq: 0 };

function resetLog(log: TurnLog): TurnLog {
  return log.entries.length === 0 ? log : { entries: [], seq: log.seq };
}

export function advanceTurnLog(
  log: TurnLog,
  prev: HushleViewState | null,
  next: HushleViewState
): TurnLog {
  if (next.phase !== 'playing' && next.phase !== 'ended') return resetLog(log);
  if (!prev) return log;
  if (prev.phase !== 'playing') return resetLog(log);

  // The reducer numbers every turn it starts.
  const newTurn =
    next.phase === 'playing' &&
    (next.turnNumber !== prev.turnNumber || next.currentTeamId !== prev.currentTeamId);
  if (newTurn) return resetLog(log);

  const before = teamById(prev, prev.currentTeamId);
  const after = teamById(next, prev.currentTeamId);
  if (!before || !after) return log;

  const outcomes: TurnOutcome[] = [];
  const push = (outcome: TurnOutcome, times: number) => {
    for (let i = 0; i < times; i += 1) outcomes.push(outcome);
  };
  push('correct', Math.max(0, after.correctCount - before.correctCount));
  push('pass', Math.max(0, after.passCount - before.passCount));
  push('penalty', Math.max(0, after.penaltyCount - before.penaltyCount));
  if (
    outcomes.length === 0 &&
    next.phase === 'playing' &&
    next.totalCardsPlayed === prev.totalCardsPlayed &&
    next.cardsPlayedThisTurn > prev.cardsPlayedThisTurn
  ) {
    push('next', next.cardsPlayedThisTurn - prev.cardsPlayedThisTurn);
  }
  if (outcomes.length === 0) return log;

  // Several events between two snapshots (a slow connection): the word
  // only belongs to one of them, so none of them claims it.
  const card: HushleCard | null = outcomes.length === 1 ? prev.currentCard : null;
  let seq = log.seq;
  const added = outcomes.map((outcome) => {
    seq += 1;
    return { key: seq, outcome, word: card?.word ?? null, language: card?.language ?? null };
  });
  return { entries: [...log.entries, ...added], seq };
}
