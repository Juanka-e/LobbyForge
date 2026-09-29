'use client';

import { useEffect, useRef } from 'react';
import { Avatar, Callout, EmptyState, Grid, Panel, SectionLabel, Stack, Stat, lf, tone } from '@lobbyforge/plugin-sdk/ui';
import { quizPodium, rankQuizPlayers } from '../roster';
import type { QuizUi, ViewProps } from './context';
import { Leaderboard } from './Leaderboard';
import { DISPLAY_FONT, MONO_FONT } from './palette';

/** Podium heights: first is tallest. Order on screen = rank order, for every reader. */
const PODIUM_HEIGHT = { 1: 200, 2: 168, 3: 144 } as const;

function placeLabel(ui: QuizUi, place: 1 | 2 | 3): string {
  const { t } = ui;
  if (place === 1) return t('quiz.ended.place1');
  if (place === 2) return t('quiz.ended.place2');
  return t('quiz.ended.place3');
}

/** The end: podium, full ranking and a few numbers. */
export function FinalView({ state, ui }: ViewProps) {
  const { t } = ui;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const ranked = rankQuizPlayers(state.players, state.questionsRevealed);
  const podium = quizPodium(ranked.filter((entry) => entry.player.score > 0));
  const answered = ranked.reduce((sum, entry) => sum + entry.player.answered, 0);
  const correct = ranked.reduce((sum, entry) => sum + entry.player.correct, 0);
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;

  useEffect(() => {
    const title = titleRef.current;
    if (!title || typeof document === 'undefined') return;
    const active = document.activeElement;
    const shell = title.closest('.lfui');
    if (!active || active === document.body || (shell && shell.contains(active))) title.focus({ preventScroll: true });
  }, []);

  const game = tone('game');

  return (
    <Stack gap={18}>
      <Panel padding={28} radius={24}>
        <Stack gap={20}>
          <Stack gap={6}>
            <h2
              ref={titleRef}
              tabIndex={-1}
              style={{ margin: 0, fontFamily: DISPLAY_FONT, fontSize: 'clamp(24px, 3vw, 32px)', fontWeight: 800, letterSpacing: '-0.01em', outline: 'none' }}
            >
              {t('quiz.ended.title')}
            </h2>
            <span style={{ fontSize: 14, color: lf.text2 }}>
              {state.endReason === 'host' ? t('quiz.ended.endedEarly') : t('quiz.ended.thanks')}
            </span>
          </Stack>
          {podium.length === 0 ? (
            <EmptyState title={t('quiz.ended.noScoresTitle')} body={t('quiz.ended.noScoresBody')} />
          ) : (
            <ol
              aria-label={t('quiz.ended.podiumTitle')}
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))',
                alignItems: 'end',
                gap: 14,
              }}
            >
              {podium.map(({ place, players }) => {
                const first = place === 1;
                const score = players[0]!.score;
                return (
                  <li
                    key={place}
                    style={{
                      boxSizing: 'border-box',
                      minHeight: PODIUM_HEIGHT[place],
                      padding: 18,
                      borderRadius: 20,
                      background: first ? game.soft : lf.raised,
                      border: `1px solid ${first ? game.line : lf.border}`,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: first ? game.text : lf.muted }}>
                      {placeLabel(ui, place)}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                      {players.map((player) => (
                        <span key={player.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <Avatar name={ui.nameOf(player.id)} size={first ? 40 : 32} />
                          <span style={{ fontSize: first ? 18 : 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ui.nameOf(player.id)}
                            {player.id === ui.me ? (
                              <span style={{ marginLeft: 8, fontSize: 11, letterSpacing: '0.06em', color: tone('accent').text }}>{t('quiz.player.youTag')}</span>
                            ) : null}
                          </span>
                        </span>
                      ))}
                    </span>
                    <span style={{ fontFamily: MONO_FONT, fontSize: first ? 26 : 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {t('quiz.ended.podiumScore', { points: ui.number(score) })}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </Stack>
      </Panel>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
          gap: 18,
          alignItems: 'start',
        }}
      >
        <Panel padding={24} radius={24}>
          <Stack gap={12}>
            <SectionLabel>{t('quiz.ended.rankingTitle')}</SectionLabel>
            {ranked.length === 0 ? (
              <span style={{ fontSize: 14, color: lf.text2 }}>{t('quiz.ended.noPlayers')}</span>
            ) : (
              <Leaderboard
                ranked={ranked}
                ui={ui}
                label={t('quiz.ended.rankingTitle')}
                detail={({ player }) =>
                  t('quiz.ended.playerStats', {
                    correct: player.correct,
                    total: Math.max(0, state.questionsRevealed - player.eligibleFrom),
                    streak: player.bestStreak,
                  })
                }
              />
            )}
          </Stack>
        </Panel>
        <Panel padding={24} radius={24}>
          <Stack gap={18}>
            <SectionLabel>{t('quiz.ended.statsTitle')}</SectionLabel>
            <Grid min={110} gap={14}>
              <Stat label={t('quiz.ended.statQuestions')} value={ui.number(state.questionsRevealed)} />
              <Stat label={t('quiz.ended.statPlayers')} value={ui.number(ranked.length)} />
              <Stat label={t('quiz.ended.statAccuracy')} value={t('quiz.ended.accuracyValue', { percent: accuracy })} tone="success" />
            </Grid>
            {ui.isHost ? <Callout tone="info">{t('quiz.ended.playAgainHint')}</Callout> : null}
          </Stack>
        </Panel>
      </div>
    </Stack>
  );
}
