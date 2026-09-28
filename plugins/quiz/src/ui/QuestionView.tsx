'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Callout, Panel, ProgressBar, Row, Stack, formatClock, lf, useNow } from '@lobbyforge/plugin-sdk/ui';
import { QUIZ_ANSWER_GRACE_MS } from '../state';
import { isEligible } from '../roster';
import { AnswerGrid } from './AnswerGrid';
import type { ViewProps } from './context';
import { isTypingTarget, optionIndexForKey, optionLetter, secondsLeft, staggerFor, timeFraction } from './helpers';
import { JoinBar } from './JoinBar';
import { DISPLAY_FONT, MONO_FONT, SR_ONLY } from './palette';

/** How long after the deadline the host's panel calls time; other players wait longer. */
const HOST_TIME_UP_DELAY_MS = 1_200;
const PLAYER_TIME_UP_DELAY_MS = 3_500;
const TIME_UP_RETRY_MS = 4_000;
const TIME_UP_ATTEMPTS = 4;
/** An answer the server never confirmed may be re-sent after this long. */
const PENDING_TIMEOUT_MS = 4_000;

export function QuestionView({ state, ui }: ViewProps) {
  const { t } = ui;
  const question = state.current;
  const headingId = useId();
  const hintId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const now = useNow(250);
  const [pending, setPending] = useState<{ index: number; choice: number; at: number } | null>(null);

  const index = question?.index ?? state.currentIndex;
  const me = ui.mePlayer;
  const eligible = me !== null && isEligible(me, index);
  const joinedForNext = me !== null && me.active && !eligible;
  const left = secondsLeft(state.deadline, now);
  const timeUp = left === 0;
  const myChoice = state.myAnswer ?? (pending && pending.index === index ? pending.choice : null);
  const locked = !eligible || myChoice !== null || timeUp;

  // Forget an optimistic choice once the server has answered for it (or clearly never will).
  useEffect(() => {
    if (!pending) return;
    if (pending.index !== index || state.myAnswer !== null) {
      setPending(null);
      return;
    }
    const id = setTimeout(() => setPending(null), Math.max(0, pending.at + PENDING_TIMEOUT_MS - Date.now()));
    return () => clearTimeout(id);
  }, [pending, index, state.myAnswer]);

  // A new question takes focus when focus was on the panel (or nowhere) —
  // the tile or button that had it has just disappeared.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof document === 'undefined') return;
    const active = document.activeElement;
    const shell = section.closest('.lfui');
    if (!active || active === document.body || (shell && shell.contains(active))) section.focus({ preventScroll: true });
  }, [index]);

  // No server timers: once the deadline has passed, call time. The host
  // first; players after a staggered wait in case the host is away. The
  // reducer ignores a call that comes too early, so this is only a nudge.
  const shouldCallTime = ui.isHost || (me !== null && me.active);
  useEffect(() => {
    if (!shouldCallTime || state.phase !== 'playing' || typeof state.deadline !== 'number') return;
    const delay = ui.isHost ? HOST_TIME_UP_DELAY_MS : PLAYER_TIME_UP_DELAY_MS + staggerFor(ui.me);
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fire = () => {
      attempts += 1;
      ui.dispatch({ type: 'time-up' });
      if (attempts < TIME_UP_ATTEMPTS) timer = setTimeout(fire, TIME_UP_RETRY_MS);
    };
    timer = setTimeout(fire, Math.max(0, state.deadline + QUIZ_ANSWER_GRACE_MS + delay - Date.now()));
    return () => clearTimeout(timer);
    // `ui` is rebuilt every render; the timer only depends on the question and the viewer's role.
  }, [shouldCallTime, state.phase, state.deadline, index, ui.isHost, ui.me]);

  if (!question) return null;

  const choose = (choice: number) => {
    if (locked) return;
    setPending({ index, choice, at: Date.now() });
    ui.dispatch({ type: 'answer', index: choice });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) return;
    const choice = optionIndexForKey(event.key, question.options.length, event);
    if (choice === null) return;
    event.preventDefault();
    choose(choice);
  };

  const total = state.questionTotal || 1;
  const fraction = timeFraction(state.questionStartedAt, state.deadline, now);
  const status = !eligible
    ? joinedForNext
      ? t('quiz.question.joinsNext')
      : t('quiz.question.spectating')
    : myChoice !== null
      ? t('quiz.question.locked', { letter: optionLetter(myChoice) })
      : timeUp
        ? t('quiz.question.timeUp')
        : null;

  return (
    <Stack gap={16}>
      <section
        ref={sectionRef}
        tabIndex={-1}
        aria-labelledby={headingId}
        aria-describedby={locked ? undefined : hintId}
        onKeyDown={onKeyDown}
        style={{ outline: 'none', minWidth: 0 }}
      >
        <Panel padding={28} radius={24}>
          <Stack gap={22}>
            {left === null ? null : (
              <Stack gap={8}>
                <Row justify="space-between" gap={12}>
                  <span style={{ fontSize: 13, color: lf.text2 }}>{timeUp ? t('quiz.question.timeUp') : t('quiz.question.fasterScoresMore')}</span>
                  <span aria-hidden="true" style={{ fontFamily: MONO_FONT, fontSize: 13, color: lf.text2 }}>
                    {formatClock(left)}
                  </span>
                </Row>
                <ProgressBar
                  value={fraction}
                  tone={left <= 5 ? 'danger' : 'accent'}
                  label={t('quiz.question.timeLabel')}
                  valueText={t('quiz.question.timeLeft', { count: left })}
                />
              </Stack>
            )}
            <h2
              id={headingId}
              style={{
                margin: 0,
                fontFamily: DISPLAY_FONT,
                fontWeight: 700,
                fontSize: 'clamp(22px, 3vw, 34px)',
                lineHeight: 1.2,
                letterSpacing: '-0.01em',
                textAlign: 'center',
                padding: '8px 12px',
                overflowWrap: 'anywhere',
              }}
            >
              {/* The header's pill shows the number; screen readers get it with the question. */}
              <span style={SR_ONLY}>{t('quiz.question.number', { number: index + 1, total })} </span>
              {question.question}
            </h2>
            <AnswerGrid
              options={question.options}
              chosen={myChoice}
              locked={locked}
              dimOthers={eligible && (myChoice !== null || timeUp)}
              onChoose={choose}
              ui={ui}
            />
            <p id={hintId} style={{ margin: 0, fontSize: 13, color: lf.muted, textAlign: 'center' }}>
              {locked ? '\u00a0' : t('quiz.question.shortcutHint', { last: optionLetter(question.options.length - 1), count: question.options.length })}
            </p>
          </Stack>
        </Panel>
      </section>

      <div role="status" aria-live="polite">
        {status ? <Callout tone={eligible ? 'info' : 'neutral'}>{status}</Callout> : null}
      </div>

      {me === null || !me.active ? <JoinBar ui={ui} playing={false} /> : null}

      {ui.isHost ? (
        <Row gap={12} wrap justify="flex-end">
          <Button variant="danger" onClick={() => ui.dispatch({ type: 'end' })}>
            {t('quiz.host.end')}
          </Button>
          <Button variant="secondary" onClick={() => ui.dispatch({ type: 'reveal' })}>
            {t('quiz.host.revealNow')}
          </Button>
        </Row>
      ) : null}
    </Stack>
  );
}
