import { createElement } from 'react';
import type { GamePlugin, GamePluginContext } from '@lobbyforge/plugin-sdk';
import { CATALOG_SUMMARY_KEY, PluginPermission, loadPluginLocale } from '@lobbyforge/plugin-sdk';
import { QUIZ_DEFAULT_ENV, quizReducer, quizValidateAction, type QuizEnv } from './actions';
import { LOCALE_TABLES, SHIPPED_LOCALES } from './locales.generated';
import { QUIZ_PLUGIN_ID } from './plugin-id';
import { QuizPanel, type QuizPanelClientProps } from './renderClient';
import { createQuizInitialState, migrateQuizState, type QuizAction, type QuizState } from './state';

/**
 * Quiz — trivia rounds for voice rooms.
 *
 * Built-in question packs (English and Turkish) or the host's own pasted
 * questions; a deadline per question; points for being right and fast;
 * the reveal shows how many picked each answer and the leaderboard.
 * Rules: ./actions. State and versioning: ./state. Docs: docs/QUIZ.md.
 *
 * Anti-cheat (beta-review, kept and extended):
 *   - one locked answer per player per question; `playerId` is injected by
 *     the host from the session, never trusted from the wire;
 *   - nothing is scored until the question is revealed, so scores cannot
 *     be used to probe which option is right;
 *   - the canonical projector (@lobbyforge/core) never sends the deck or
 *     anyone else's answers — only the open question, counts, and the
 *     viewer's own choice.
 */

// Also registered by the panel, but that is a 'use client' module the
// server never evaluates — the host reads `catalog.summary` server-side.
loadPluginLocale(QUIZ_PLUGIN_ID, LOCALE_TABLES);

export { QUIZ_PLUGIN_ID } from './plugin-id';
export {
  QUIZ_ANSWER_GRACE_MS,
  QUIZ_BASE_POINTS,
  QUIZ_DEFAULT_QUESTION_COUNT,
  QUIZ_DEFAULT_SECONDS,
  QUIZ_MAX_NAME,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_PLAYERS,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MIN_OPTIONS,
  QUIZ_QUESTION_COUNTS,
  QUIZ_SECONDS_OPTIONS,
  QUIZ_SPEED_POINTS,
  QUIZ_STATE_VERSION,
  QUIZ_STREAK_MAX_BONUS,
  QUIZ_STREAK_STEP,
  createQuizInitialState,
  migrateQuizState,
} from './state';
export type {
  QuizAction,
  QuizAnswer,
  QuizClientAction,
  QuizDeckQuestion,
  QuizEndReason,
  QuizPhase,
  QuizPlayer,
  QuizPublicQuestion,
  QuizQuestion,
  QuizReveal,
  QuizRoundResult,
  QuizSettings,
  QuizSource,
  QuizStartAction,
  QuizState,
  QuizViewState,
} from './state';
export { quizPointsFor, quizReducer, quizValidateAction, type QuizEnv } from './actions';
// The pack CATALOGUE only. Questions and answers are server-only:
// `@lobbyforge/quiz/packs` (see src/packs/server.ts).
export {
  QUIZ_PACK_CATALOG,
  findQuizPackSummary,
  quizPacksForLocale,
  type QuizPackSummary,
} from './packs';
export { parseCustomQuestions, type QuizParseError, type QuizParseResult } from './custom';
export { rankQuizPlayers } from './roster';
export { QuizPanel, type QuizPanelClientProps, type QuizPanelProps } from './renderClient';

/** @deprecated Kept for older imports — use `QuizPanelClientProps`. */
export type QuizClientProps = QuizPanelClientProps;

/**
 * Server time and randomness, plus the host's names for players: the host
 * adds whoever acts to the session roster BEFORE the reducer runs, so
 * `ctx.players.get(id)` names the player who is joining. A "name" that is
 * just the id means the host has none.
 */
export function quizEnvFor(ctx: Pick<GamePluginContext, 'players'> | null | undefined): QuizEnv {
  return {
    ...QUIZ_DEFAULT_ENV,
    nameOf: (userId) => {
      try {
        const name = ctx?.players?.get(userId)?.name;
        return typeof name === 'string' && name.trim() !== '' && name !== userId ? name : null;
      } catch {
        return null;
      }
    },
  };
}

export const quizPlugin: GamePlugin<QuizState, QuizAction> = {
  manifest: {
    id: QUIZ_PLUGIN_ID,
    name: 'Quiz',
    version: '0.3.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.MANAGE_SCORES,
      PluginPermission.SEND_ROOM_MESSAGE,
      PluginPermission.MANAGE_TIMER,
    ],
    // Derived from locales/*.json, so the catalogue can never claim a
    // language the plugin does not actually ship.
    locales: SHIPPED_LOCALES,
    entryClient: './renderClient.js',
    catalog: {
      category: 'game',
      // Translated in locales/*.json; the host shows the viewer's language.
      summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY],
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 1,
        maxPlayers: 32,
        defaultMaxPlayers: 12,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['trivia', 'party', 'voice'],
    },
  },
  actionPolicies: {
    start: { role: 'host' },
    // Legacy paste flow: starts a custom quiz straight away.
    'set-questions': { role: 'host' },
    reveal: { role: 'host' },
    next: { role: 'host' },
    end: { role: 'host' },
    // Another round in the same session, from the final results.
    'play-again': { role: 'host' },
    // Any member plays or watches; the host injects WHO from the session.
    join: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
    // Leaving works from outside the voice room too.
    leave: { role: 'member', actorFields: ['playerId'], allowOutsideVoice: true },
    answer: { role: 'member', actorFields: ['playerId'] },
    // Anyone may call time — the reducer checks the server clock.
    'time-up': { role: 'member' },
  },
  // A finished quiz accepts only "play again"; every other action is
  // refused by the host with `session_ended`.
  restartActions: ['play-again'],
  // The session's creator is the host and joins as a player.
  createInitialState: (ctx) => createQuizInitialState(ctx?.actorUserId ?? null),
  validateAction: quizValidateAction,
  migrateState: migrateQuizState,
  handleAction: (ctx, rawState, action) => {
    // Defense in depth: validateAction guards the API boundary, but the
    // reducer never trusts shape either.
    if (quizValidateAction(action) !== null) return rawState;
    return quizReducer(migrateQuizState(rawState), action, quizEnvFor(ctx));
  },
  // Return an ELEMENT, never call the panel: its hooks must belong to its
  // own component instance (see Hushle's beta-review note).
  renderClient: (props: unknown) => createElement(QuizPanel, props as QuizPanelClientProps),
};
