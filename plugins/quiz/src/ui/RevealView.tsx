'use client';

import { useEffect, useId, useRef } from 'react';
import { Button, Callout, Panel, SectionLabel, Stack, lf, tone } from '@lobbyforge/plugin-sdk/ui';
import { rankQuizPlayers } from '../roster';
import type { ViewProps } from './context';
import { optionLetter } from './helpers';
import { JoinBar } from './JoinBar';
import { Leaderboard } from './Leaderboard';
import { DISPLAY_FONT, ON_SWATCH, SR_ONLY, optionSwatch } from './palette';

/** The answer, how many picked each option (counts only — never who), and the leaderboard. */
export function RevealView({ state, ui }: ViewProps) {
  const { t } = ui;
  const reveal = state.reveal;
  const question = state.current;
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading || typeof document === 'undefined') return;
    const active = document.activeElement;
    const shell = heading.closest('.lfui');
    if (!active || active === document.body || (shell && shell.contains(active))) heading.focus({ preventScroll: true });
  }, [reveal?.index]);

  if (!reveal || !question) return null;

  const correctText = question.options[reveal.correctIndex] ?? '';
  const last = state.currentIndex >= state.questionTotal - 1;
  const me = ui.mePlayer;
  const success = tone('success');
  const most = Math.max(1, ...reveal.counts);

  let result: { tone: 'success' | 'danger' | 'info' | 'neutral'; text: string } | null = null;
  if (me && me.lastResult === 'correct') {
    const gain = t('quiz.reveal.youGotIt', { points: ui.number(me.lastGain) });
    result = { tone: 'success', text: me.streak > 1 ? `${gain} ${t('quiz.reveal.streak', { count: me.streak })}` : gain };
  } else if (me && me.lastResult === 'wrong') {
    result = { tone: 'danger', text: t('quiz.reveal.youMissed') };
  } else if (me && me.lastResult === 'missed') {
    result = { tone: 'neutral', text: t('quiz.reveal.noAnswer') };
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
        gap: 18,
        alignItems: 'start',
      }}
    >
      <Panel padding={28} radius={24}>
        <Stack gap={16}>
          <SectionLabel>{t('quiz.question.number', { number: reveal.index + 1, total: state.questionTotal })}</SectionLabel>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: lf.text2, overflowWrap: 'anywhere' }}>{question.question}</p>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            style={{ margin: 0, fontFamily: DISPLAY_FONT, fontSize: 'clamp(20px, 2.4vw, 26px)', fontWeight: 700, lineHeight: 1.3, outline: 'none', overflowWrap: 'anywhere' }}
          >
            {t('quiz.reveal.correctAnswer', { letter: optionLetter(reveal.correctIndex), text: correctText })}
          </h2>
          <div role="status">{result ? <Callout tone={result.tone}>{result.text}</Callout> : null}</div>
          <ol aria-labelledby={headingId} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {question.options.map((text, index) => {
              const count = reveal.counts[index] ?? 0;
              const correct = index === reveal.correctIndex;
              const mine = state.myAnswer === index;
              return (
                <li key={index} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 26,
                        height: 26,
                        flexShrink: 0,
                        borderRadius: 8,
                        background: optionSwatch(index),
                        color: ON_SWATCH,
                        fontSize: 13,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {optionLetter(index)}
                    </span>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere', fontWeight: correct ? 600 : 400 }}>
                      <span style={SR_ONLY}>{optionLetter(index)}: </span>
                      {text}
                    </span>
                    {correct ? (
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: success.text }}>
                        {'✓ '}
                        {t('quiz.reveal.correctTag')}
                      </span>
                    ) : null}
                    {mine ? (
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: tone('accent').text }}>
                        {t('quiz.question.yourAnswer')}
                      </span>
                    ) : null}
                    <span style={{ marginLeft: 'auto', color: lf.text2, whiteSpace: 'nowrap' }}>{t('quiz.reveal.picked', { count })}</span>
                  </div>
                  <div aria-hidden="true" style={{ height: 12, borderRadius: 12, background: lf.container, overflow: 'hidden' }}>
                    <div
                      className="lfui-bar-fill"
                      style={{
                        width: `${Math.round((count / most) * 100)}%`,
                        height: '100%',
                        borderRadius: 12,
                        background: correct ? success.fill : lf.borderStrong,
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          <p style={{ margin: 0, fontSize: 13, color: lf.muted }}>
            {t('quiz.reveal.summary', { answered: reveal.answered, correct: reveal.correct })}
          </p>
        </Stack>
      </Panel>

      <Panel padding={24} radius={24}>
        <Stack gap={12}>
          <SectionLabel>{t('quiz.leaderboard.title')}</SectionLabel>
          <Leaderboard ranked={rankQuizPlayers(state.players)} ui={ui} showGains label={t('quiz.leaderboard.title')} />
          {ui.isHost ? (
            <Stack gap={10}>
              <Button variant="primary" size="lg" block onClick={() => ui.dispatch({ type: 'next' })}>
                {last ? t('quiz.host.finish') : t('quiz.host.next')}
              </Button>
              {last ? null : (
                <Button variant="ghost" size="sm" onClick={() => ui.dispatch({ type: 'end' })}>
                  {t('quiz.host.end')}
                </Button>
              )}
            </Stack>
          ) : (
            <Callout tone="info">
              {ui.hostName ? t('quiz.reveal.waitingForHost', { name: ui.hostName }) : t('quiz.reveal.waitingForAnyHost')}
            </Callout>
          )}
          {me === null || !me.active ? <JoinBar ui={ui} playing={false} compact /> : null}
        </Stack>
      </Panel>
    </div>
  );
}
