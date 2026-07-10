import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  timeLimitSeconds: number;
}

export interface QuizState {
  questions: QuizQuestion[];
  currentIndex: number;
  score: number;
  correctCount: number;
  totalAnswered: number;
  finished: boolean;
}

export type QuizAction =
  | { type: 'set-questions'; questions: QuizQuestion[] }
  | { type: 'answer'; index: number }
  | { type: 'next' }
  | { type: 'end' };

export const quizPlugin: GamePlugin<QuizState, QuizAction> = {
  manifest: {
    id: 'quiz',
    name: 'Quiz',
    version: '0.1.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.MANAGE_SCORES,
      PluginPermission.SEND_ROOM_MESSAGE,
      PluginPermission.MANAGE_TIMER,
    ],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'game',
      summary: 'Fast trivia rounds for voice rooms.',
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
    'set-questions': { role: 'host' },
    answer: { role: 'member' },
    next: { role: 'host' },
    end: { role: 'host' },
  },
  createInitialState: () => ({
    questions: [],
    currentIndex: 0,
    score: 0,
    correctCount: 0,
    totalAnswered: 0,
    finished: false,
  }),
  handleAction: (_ctx, state, action) => {
    switch (action.type) {
      case 'set-questions':
        return { ...state, questions: action.questions, currentIndex: 0, finished: false };
      case 'answer': {
        const q = state.questions[state.currentIndex];
        if (!q) return state;
        const correct = action.index === q.correctIndex;
        return {
          ...state,
          score: correct ? state.score + 1 : state.score,
          correctCount: correct ? state.correctCount + 1 : state.correctCount,
          totalAnswered: state.totalAnswered + 1,
        };
      }
      case 'next':
        return {
          ...state,
          currentIndex: state.currentIndex + 1,
          finished: state.currentIndex + 1 >= state.questions.length,
        };
      case 'end':
        return { ...state, finished: true };
      default:
        return state;
    }
  },
  renderClient: () => null,
};
