'use client';

import { lf, tone } from '@lobbyforge/plugin-sdk/ui';
import type { QuizUi } from './context';
import { optionLetter } from './helpers';
import { ON_SWATCH, optionSwatch } from './palette';

/**
 * The answer tiles. Real buttons: Tab reaches them, Enter/Space picks one.
 * Once an answer is locked they stay focusable (`aria-disabled`, not
 * `disabled`) so keyboard focus is not thrown back to the page.
 */
export function AnswerGrid({
  options,
  chosen,
  locked,
  dimOthers,
  onChoose,
  ui,
}: {
  options: string[];
  /** The viewer's locked (or just sent) answer. */
  chosen: number | null;
  /** No more answers: already answered, time is up, or the viewer is watching. */
  locked: boolean;
  /** Fade the options the viewer did not pick (after answering or at time-up; never for spectators). */
  dimOthers: boolean;
  onChoose: (index: number) => void;
  ui: QuizUi;
}) {
  const { t } = ui;
  const accent = tone('accent');
  // Two tiles per row, as in the design, one per row when the column is
  // narrow: flex-wrap instead of an auto-fit grid, which would put three
  // of four tiles on a wide row.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
      {options.map((text, index) => {
        const letter = optionLetter(index);
        const isChosen = chosen === index;
        const dimmed = dimOthers && !isChosen;
        return (
          <button
            key={index}
            type="button"
            className={locked ? 'lfui-focus' : 'lfui-option lfui-focus'}
            aria-pressed={isChosen}
            aria-disabled={locked || undefined}
            aria-label={t('quiz.question.optionLabel', { letter, text })}
            onClick={() => {
              if (!locked) onChoose(index);
            }}
            style={{
              minHeight: 84,
              boxSizing: 'border-box',
              padding: '12px 20px',
              borderRadius: 18,
              border: `2px solid ${isChosen ? accent.fill : lf.border}`,
              background: isChosen ? accent.soft : lf.raised,
              color: lf.text,
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              textAlign: 'left',
              opacity: dimmed ? 0.55 : 1,
              cursor: locked ? 'default' : 'pointer',
              flex: '1 1 calc(50% - 7px)',
              minWidth: 'min(240px, 100%)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 44,
                height: 44,
                flexShrink: 0,
                borderRadius: 12,
                background: optionSwatch(index),
                color: ON_SWATCH,
                fontWeight: 700,
                fontSize: 17,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {letter}
            </span>
            <span aria-hidden="true" style={{ fontSize: 'clamp(16px, 1.6vw, 19px)', fontWeight: 500, lineHeight: 1.35, minWidth: 0, overflowWrap: 'anywhere', flexGrow: 1 }}>
              {text}
            </span>
            {isChosen ? (
              <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: accent.text, whiteSpace: 'nowrap' }}>
                {t('quiz.question.yourAnswer')}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
