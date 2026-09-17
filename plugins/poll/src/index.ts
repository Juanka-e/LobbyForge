import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

/**
 * Poll — a live poll for voice rooms.
 *
 * The host opens a question with 2–6 options; every participant votes
 * exactly once (one-vote-per-player is enforced in state, not UI);
 * the host closes the poll and the room sees the tally. Simple on
 * purpose: it is the reference example for the plugin reducer model
 * (pure State → Action → State, server-side projection, no trust in
 * the client).
 */

export const POLL_PLUGIN_ID = 'poll';
export const POLL_MAX_OPTIONS = 6;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_QUESTION_LENGTH = 200;
export const POLL_MAX_OPTION_LENGTH = 80;

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];
}

export interface PollState {
  question: string | null;
  options: PollOption[];
  phase: 'idle' | 'open' | 'closed';
  hostId: string | null;
  /** Players who voted in the CURRENT poll — reset on open. */
  ballotBox: string[];
  createdAt: string | null;
  closedAt: string | null;
}

export type PollAction =
  | { type: 'open-poll'; hostId: string; question: string; options: string[] }
  | { type: 'vote'; playerId: string; optionId: string }
  | { type: 'close-poll'; hostId: string }
  | { type: 'reopen-poll'; hostId: string }
  | { type: 'clear-poll'; hostId: string };

function countVotes(options: PollOption[]): number {
  return options.reduce((sum, option) => sum + option.voterIds.length, 0);
}

export function pollTally(state: PollState): { optionId: string; votes: number }[] {
  return state.options.map((option) => ({ optionId: option.id, votes: option.voterIds.length }));
}

export function pollLeader(state: PollState): string | null {
  let best: { id: string; votes: number } | null = null;
  let tie = false;
  for (const option of state.options) {
    const votes = option.voterIds.length;
    if (!best || votes > best.votes) {
      best = { id: option.id, votes };
      tie = false;
    } else if (votes === best.votes && votes > 0) {
      tie = true;
    }
  }
  return best && best.votes > 0 && !tie ? best.id : null;
}

export const pollPlugin: GamePlugin<PollState, PollAction> = {
  manifest: {
    id: POLL_PLUGIN_ID,
    name: 'Poll',
    version: '0.1.0',
    type: 'utility',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.SEND_ROOM_MESSAGE,
    ],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'utility',
      summary: 'Live one-vote-per-player polls for voice rooms.',
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
      requiresVoiceRoom: true,
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
  createInitialState: (): PollState => ({
    question: null,
    options: [],
    phase: 'idle',
    hostId: null,
    ballotBox: [],
    createdAt: null,
    closedAt: null,
  }),
  handleAction: (_ctx, state, action) => {
    switch (action.type) {
      case 'open-poll': {
        const question = action.question.trim();
        const options = action.options.map((text) => text.trim()).filter(Boolean);
        if (question.length < 1 || question.length > POLL_MAX_QUESTION_LENGTH) return state;
        if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return state;
        if (options.some((text) => text.length > POLL_MAX_OPTION_LENGTH)) return state;
        return {
          question,
          options: options.map((text, index) => ({ id: `opt-${index + 1}`, text, voterIds: [] })),
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
            o.id === action.optionId ? { ...o, voterIds: [...o.voterIds, action.playerId] } : o
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
        // Reopening keeps the tally but allows NEW voters only — the
        // ballot box is NOT reset, so nobody votes twice across the gap.
        return { ...state, phase: 'open', closedAt: null };
      }
      case 'clear-poll': {
        return pollPlugin.createInitialState(_ctx);
      }
      default:
        return state;
    }
  },
  renderClient: () => null,
};

export { countVotes };
