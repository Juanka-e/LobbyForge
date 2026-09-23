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
  | { type: 'vote'; playerId: string; optionId: string }
  | { type: 'close-poll'; hostId: string }
  | { type: 'reopen-poll'; hostId: string }
  | { type: 'clear-poll'; hostId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function pristineState(): PollState {
  return {
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
  handleAction: (_ctx, state, action) => {
    // Defense in depth: validateAction guards the API boundary, but the
    // reducer never trusts shape either.
    if (pollValidateAction(action) !== null) return state;
    switch (action.type) {
      case 'open-poll': {
        const question = action.question.trim();
        const options = action.options.map((text) => text.trim()).filter(Boolean);
        return {
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
        return pristineState();
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
