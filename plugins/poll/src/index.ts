import { createElement } from 'react';
import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { CATALOG_SUMMARY_KEY, PluginPermission, loadPluginLocale } from '@lobbyforge/plugin-sdk';
import {
  POLL_PLUGIN_ID,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MAX_OPTION_LENGTH,
} from './constants';
import { PollPanel, type PollPanelClientProps } from './renderClient';
import { LOCALE_TABLES, SHIPPED_LOCALES } from './locales.generated';

// Also registered by the panel, but that is a 'use client' module the
// server never evaluates — the host reads `catalog.summary` server-side.
loadPluginLocale(POLL_PLUGIN_ID, LOCALE_TABLES);

/**
 * Poll — an anonymous live poll for channels.
 *
 * DESIGN DECISIONS (31st audit):
 * - **Anonymous by construction.** State stores per-option VOTE COUNTS
 *   and a ballot box (who has voted) — never WHO voted for WHAT.
 * - **The ballot box never leaves the server** (beta-review S11). It is
 *   append-ordered, so diffing two broadcast revisions (the new id in
 *   the box + the option whose count moved) de-anonymised every vote.
 *   The canonical projector in @lobbyforge/core replaces it with
 *   `ballotCount` + the viewer's own `hasVoted` (see PollViewState);
 *   `ballotBox` stays in canonical state only for one-vote enforcement.
 *   (Still no "which option did I pick" — the client may remember that
 *   locally.)
 * - **Any channel member may vote.** The action policy is `role: member`;
 *   the host's voice context is still a stub (getParticipants → []),
 *   so "only people in the voice room" is not enforceable server-side
 *   today. `requiresVoiceRoom: false` states the honest contract.
 * - **Malformed actions are rejected before dispatch** via validateAction
 *   (the activity API only checks `{ type }` at its boundary); the
 *   reducer still guards defensively.
 * - **A vote names its poll** (B-06, stale intent). Option ids repeat
 *   from poll to poll (`opt-1`…), so a vote sent for one poll could land
 *   on the next one the host opened after clearing it. Every `open-poll`
 *   numbers the poll (`pollId`, never reused in the session); a vote
 *   carrying another poll's number is ignored. A vote without one (a
 *   panel from before it) counts for the open poll, as it always did.
 */

export {
  POLL_PLUGIN_ID,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MAX_OPTION_LENGTH,
} from './constants';

export { PollPanel } from './renderClient';
export type { PollPanelClientProps, PollPanelProps } from './renderClient';

export interface PollOption {
  id: string;
  text: string;
  votes: number;
}

export interface PollState {
  /**
   * Which poll of this session is (or was last) on: each `open-poll` adds
   * one, `clear-poll` keeps it, close / reopen leave it alone (the same
   * poll). Public — it counts polls, nothing more. `vote` carries the
   * number its options were drawn for, so a late vote cannot land on a
   * newer poll whose options happen to share its ids.
   */
  pollId: number;
  question: string | null;
  options: PollOption[];
  phase: 'idle' | 'open' | 'closed';
  hostId: string | null;
  /**
   * Players who cast a ballot in the CURRENT poll — no choices. SERVER
   * ONLY: projected to `ballotCount` / `hasVoted` for every viewer.
   */
  ballotBox: string[];
  createdAt: string | null;
  closedAt: string | null;
}

/**
 * What a viewer receives (REST/SSE/WS all run the canonical projector):
 * the ballot box is replaced by the turnout and the viewer's own flag.
 */
export type PollViewState = Omit<PollState, 'ballotBox'> & {
  ballotCount: number;
  hasVoted: boolean;
};

export type PollAction =
  | { type: 'open-poll'; hostId: string; question: string; options: string[] }
  /**
   * `pollId` is the poll the voter saw. When present and not the poll on
   * now, the vote is ignored; absent (or null), it counts for the open poll.
   */
  | { type: 'vote'; playerId: string; optionId: string; pollId?: number | null }
  | { type: 'close-poll'; hostId: string }
  | { type: 'reopen-poll'; hostId: string }
  | { type: 'clear-poll'; hostId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPollId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The poll number in state; a row from before poll numbers counts as 0. */
function pollIdOf(state: { pollId?: unknown } | null | undefined): number {
  const id = state?.pollId;
  return isPollId(id) ? id : 0;
}

/**
 * Brings a persisted state up to the current shape (the host runs it on
 * every read and before every action). Rows written before poll numbers
 * have none: they get 0 — the same on every read, so a panel that read the
 * migrated state names the poll the reducer sees. Idempotent; a current
 * state comes back as the same object.
 */
export function migratePollState(raw: unknown): PollState {
  if (!isRecord(raw)) return pristineState();
  if (isPollId(raw.pollId)) return raw as unknown as PollState;
  return { ...(raw as unknown as PollState), pollId: 0 };
}

export function pollValidateAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  switch (action.type) {
    case 'open-poll': {
      if (typeof action.hostId !== 'string' || action.hostId.length === 0) {
        return 'open-poll requires a hostId string.';
      }
      if (typeof action.question !== 'string') return 'question must be a string.';
      const question = action.question.trim();
      if (question.length < 1 || question.length > POLL_MAX_QUESTION_LENGTH) {
        return `question must be 1–${POLL_MAX_QUESTION_LENGTH} characters.`;
      }
      if (!Array.isArray(action.options)) return 'options must be an array of strings.';
      if (action.options.some((o) => typeof o !== 'string')) {
        return 'options must be an array of strings.';
      }
      const texts = (action.options as string[]).map((t) => t.trim()).filter(Boolean);
      if (texts.length < POLL_MIN_OPTIONS || texts.length > POLL_MAX_OPTIONS) {
        return `options must contain ${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} non-empty entries.`;
      }
      if (texts.some((t) => t.length > POLL_MAX_OPTION_LENGTH)) {
        return `each option must be at most ${POLL_MAX_OPTION_LENGTH} characters.`;
      }
      return null;
    }
    case 'vote':
      if (typeof action.playerId !== 'string' || action.playerId.length === 0) {
        return 'vote requires a playerId string.';
      }
      if (typeof action.optionId !== 'string' || action.optionId.length === 0) {
        return 'vote requires an optionId string.';
      }
      if (action.pollId != null && !isPollId(action.pollId)) {
        return 'vote: pollId must be a non-negative integer when present.';
      }
      return null;
    case 'close-poll':
    case 'reopen-poll':
    case 'clear-poll':
      if (typeof action.hostId !== 'string' || action.hostId.length === 0) {
        return `${String(action.type)} requires a hostId string.`;
      }
      return null;
    default:
      return `Unknown action type: ${String(action.type)}`;
  }
}

export { pollTally, pollLeader } from './tally';

function pristineState(pollId = 0): PollState {
  return {
    pollId,
    question: null,
    options: [],
    phase: 'idle',
    hostId: null,
    ballotBox: [],
    createdAt: null,
    closedAt: null,
  };
}

export const pollPlugin: GamePlugin<PollState, PollAction> = {
  manifest: {
    id: POLL_PLUGIN_ID,
    name: 'Poll',
    version: '0.2.0',
    type: 'utility',
    minAppVersion: '0.1.0',
    permissions: [PluginPermission.MANAGE_GAME_SESSION, PluginPermission.SEND_ROOM_MESSAGE],
    // Derived from locales/*.json, so the catalogue can never claim a
    // language the plugin does not actually ship.
    locales: SHIPPED_LOCALES,
    entryClient: './renderClient.js',
    catalog: {
      category: 'utility',
      // Translated in locales/*.json; the host shows the viewer's language.
      summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY],
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 2,
        maxPlayers: 50,
        defaultMaxPlayers: 25,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      // Honest contract: any channel member can vote. Voice-presence
      // enforcement becomes possible once the host voice context is live.
      requiresVoiceRoom: false,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['poll', 'voting', 'utility'],
    },
  },
  actionPolicies: {
    'open-poll': { role: 'host', actorFields: ['hostId'] },
    vote: { role: 'member', actorFields: ['playerId'] },
    'close-poll': { role: 'host', actorFields: ['hostId'] },
    'reopen-poll': { role: 'host', actorFields: ['hostId'] },
    'clear-poll': { role: 'host', actorFields: ['hostId'] },
  },
  createInitialState: (): PollState => pristineState(),
  validateAction: pollValidateAction,
  migrateState: (raw: unknown) => migratePollState(raw),
  handleAction: (_ctx, state, action) => {
    // Defense in depth: validateAction guards the API boundary, but the
    // reducer never trusts shape either.
    if (pollValidateAction(action) !== null) return state;
    switch (action.type) {
      case 'open-poll': {
        const question = action.question.trim();
        const options = action.options.map((text) => text.trim()).filter(Boolean);
        return {
          // A new poll, a new number: votes meant for an earlier poll
          // (whose option ids repeat these) no longer match.
          pollId: pollIdOf(state) + 1,
          question,
          options: options.map((text, index) => ({ id: `opt-${index + 1}`, text, votes: 0 })),
          phase: 'open',
          hostId: action.hostId,
          ballotBox: [],
          createdAt: new Date().toISOString(),
          closedAt: null,
        };
      }
      case 'vote': {
        if (state.phase !== 'open') return state;
        // Stale intent: a vote for another poll (sent before the host
        // cleared it and opened this one) is ignored, not counted here.
        if (action.pollId != null && action.pollId !== pollIdOf(state)) return state;
        // One person, one ballot — enforced in state, not by the client.
        if (state.ballotBox.includes(action.playerId)) return state;
        const option = state.options.find((o) => o.id === action.optionId);
        if (!option) return state;
        return {
          ...state,
          options: state.options.map((o) =>
            o.id === action.optionId ? { ...o, votes: o.votes + 1 } : o
          ),
          ballotBox: [...state.ballotBox, action.playerId],
        };
      }
      case 'close-poll': {
        if (state.phase !== 'open') return state;
        return { ...state, phase: 'closed', closedAt: new Date().toISOString() };
      }
      case 'reopen-poll': {
        if (state.phase !== 'closed') return state;
        // Keeps the tally AND the ballot box — nobody votes twice across
        // the close/reopen gap.
        return { ...state, phase: 'open', closedAt: null };
      }
      case 'clear-poll': {
        // The number stays, so the next poll gets a fresh one.
        return pristineState(pollIdOf(state));
      }
      default:
        return state;
    }
  },
  /**
   * Returns an ELEMENT — it must never CALL PollPanel. Invoking the
   * component as a plain function appends its hooks (useState /
   * useMemo) to whatever component called renderClient; the host
   * mounts the panel conditionally, so the hook count changes between
   * renders and React throws #310, dropping the entire voice room into
   * its error boundary. See plugins/hushle/src/index.ts for the
   * regression this mirrors.
   *
   * `props.state` is a PollViewState (ballotBox stripped, ballotCount
   * + hasVoted added), which is why the panel types it that way.
   */
  renderClient: (props: unknown) =>
    createElement(PollPanel, props as PollPanelClientProps),
};
