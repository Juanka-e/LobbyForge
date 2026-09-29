'use client';

import { Button, Row, lf } from '@lobbyforge/plugin-sdk/ui';
import type { QuizUi } from './context';

/**
 * Join / leave the quiz. No name field: the host knows every player's
 * display name as soon as they act, and the leaderboard uses it.
 */
export function JoinBar({ ui, playing, compact = false }: { ui: QuizUi; playing: boolean; compact?: boolean }) {
  const { t } = ui;
  if (playing) {
    return (
      <Row gap={12} wrap justify="space-between">
        <span style={{ fontSize: 14, color: lf.text2 }}>{t('quiz.join.playing')}</span>
        <Button variant="secondary" size="sm" onClick={() => ui.dispatch({ type: 'leave' })}>
          {t('quiz.join.leave')}
        </Button>
      </Row>
    );
  }
  return (
    <Row gap={12} wrap>
      <Button variant="primary" size={compact ? 'sm' : 'md'} onClick={() => ui.dispatch({ type: 'join' })}>
        {t('quiz.join.join')}
      </Button>
    </Row>
  );
}
