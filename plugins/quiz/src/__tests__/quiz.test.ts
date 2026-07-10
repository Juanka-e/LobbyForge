import { describe, it, expect } from 'vitest';
import { quizPlugin, type QuizState, type QuizQuestion } from '../index.js';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

const questions: QuizQuestion[] = [
  { id: 'q1', question: '2+2?', options: ['3', '4', '5'], correctIndex: 1, timeLimitSeconds: 20 },
  { id: 'q2', question: 'Capital of TR?', options: ['Istanbul', 'Ankara', 'Izmir'], correctIndex: 1, timeLimitSeconds: 20 },
];

describe('@lobbyforge/quiz', () => {
  it('scores correctly and progresses', async () => {
    const harness = createTestHarness<QuizState, Parameters<typeof quizPlugin.handleAction>[2]>({
      plugin: quizPlugin,
      players: ['p1'],
    });

    await harness.startGame();
    await harness.performAction('p1', { type: 'set-questions', questions });
    expect(harness.getState().questions).toHaveLength(2);

    await harness.performAction('p1', { type: 'answer', index: 1 });
    expect(harness.getState().correctCount).toBe(1);
    expect(harness.getState().score).toBe(1);

    await harness.performAction('p1', { type: 'next' });
    expect(harness.getState().currentIndex).toBe(1);
    expect(harness.getState().finished).toBe(false);

    await harness.performAction('p1', { type: 'next' });
    expect(harness.getState().finished).toBe(true);
  });
});
