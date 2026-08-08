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

export interface QuizClientProps {
  state: QuizState;
  dispatch: (action: QuizAction) => void;
  actorUserId: string;
  hostUserId: string;
  players: Array<{ id: string; displayName: string }>;
}

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
  renderClient: (props) => {
    const { state, dispatch, actorUserId, hostUserId } = props as QuizClientProps;

    if (state.finished) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e2ea' }}>
            Quiz Complete!
          </h2>
          <p style={{ fontSize: 18, color: '#8fb8ff', marginTop: 12 }}>
            Score: {state.score} · {state.correctCount}/{state.totalAnswered} correct
          </p>
          {hostUserId === actorUserId ? (
            <button
              onClick={() => dispatch({ type: 'end' })}
              style={{
                marginTop: 16, padding: '10px 24px', borderRadius: 8,
                background: '#8fb8ff', color: '#070a0f', border: 'none',
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              Close
            </button>
          ) : null}
        </div>
      );
    }

    const question = state.questions[state.currentIndex];
    if (!question) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <p style={{ color: '#8b93a7' }}>
            {hostUserId === actorUserId
              ? 'Add questions to start the quiz.'
              : 'Waiting for the host to start...'}
          </p>
        </div>
      );
    }

    return (
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 14, color: '#8b93a7' }}>
            Question {state.currentIndex + 1} / {state.questions.length}
          </span>
          <span style={{ fontSize: 14, color: '#8fb8ff', fontWeight: 600 }}>
            Score: {state.score}
          </span>
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 600, color: '#e0e2ea', marginBottom: 16 }}>
          {question.question}
        </h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {question.options.map((option, idx) => (
            <button
              key={idx}
              onClick={() => dispatch({ type: 'answer', index: idx })}
              style={{
                padding: '12px 16px', borderRadius: 8, textAlign: 'left',
                background: '#171e2b', color: '#e0e2ea', border: '1px solid #1f2738',
                cursor: 'pointer', fontSize: 14,
              }}
            >
              {option}
            </button>
          ))}
        </div>
        {hostUserId === actorUserId ? (
          <button
            onClick={() => dispatch({ type: 'next' })}
            style={{
              marginTop: 16, padding: '10px 24px', borderRadius: 8,
              background: '#8fb8ff', color: '#070a0f', border: 'none',
              fontWeight: 600, cursor: 'pointer', width: '100%',
            }}
          >
            Next Question →
          </button>
        ) : null}
      </div>
    );
  },
};
