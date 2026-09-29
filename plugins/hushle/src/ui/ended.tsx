'use client';

import {
  Button,
  Callout,
  Grid,
  Panel,
  PhasePill,
  Row,
  Scoreboard,
  SectionLabel,
  Stack,
  Stat,
  lf,
  tone,
} from '@lobbyforge/plugin-sdk/ui';
import { listOf, useHushleI18n } from './i18n';
import { gameTotals, setupFromSettings, standings, startGameAction } from './model';
import { TrophyIcon } from './parts';
import { HushleHeader, isHostViewer, type ViewProps } from './shared';
import { DISPLAY_FONT } from './theme';

/** The final screen: who won, every team's score, and how the game went. */
export function EndedView(props: ViewProps) {
  const { t, locale } = useHushleI18n();
  const { state, dispatch, actorUserId, players, hostUserId } = props;
  const isHost = isHostViewer(props);
  const { ranked, leaders } = standings(state.teams);
  const totals = gameTotals(state);
  const decided = totals.played > 0 && leaders.length > 0;
  const top = leaders[0];

  const headline = !decided || !top
    ? { title: t('hushle.ended.noCards'), body: null }
    : leaders.length === 1
      ? { title: t('hushle.ended.winner', { team: top.name }), body: t('hushle.ended.winnerScore', { count: top.score }) }
      : {
          title: t('hushle.ended.tie'),
          body: t('hushle.ended.tieBody', {
            teams: listOf(
              leaders.map((team) => team.name),
              locale
            ),
            count: top.score,
          }),
        };

  return (
    <>
      <HushleHeader
        hostUserId={hostUserId}
        players={players}
        detail={t('hushle.header.cardsPlayed', { count: totals.played })}
        status={<PhasePill tone="success">{t('hushle.ended.title')}</PhasePill>}
        actions={
          isHost ? (
            <Button
              variant="primary"
              onClick={() => {
                // A new game with the same pack and settings; the reducer
                // sends everyone back to team setup.
                void dispatch(startGameAction(setupFromSettings(state.settings), actorUserId));
              }}
            >
              {t('hushle.ended.newGame')}
            </Button>
          ) : null
        }
      />

      <Panel highlight={decided ? 'game' : undefined} padding={24} radius={24} className="lfui-pop">
        <Row gap={18} wrap>
          <span aria-hidden="true" style={{ color: decided ? tone('game').text : lf.muted, display: 'inline-flex' }}>
            <TrophyIcon size={44} />
          </span>
          <Stack gap={6} style={{ flex: '1 1 240px' }}>
            <SectionLabel>{t('hushle.ended.title')}</SectionLabel>
            <span
              role="status"
              style={{ fontFamily: DISPLAY_FONT, fontSize: 32, fontWeight: 800, lineHeight: 1.1, overflowWrap: 'anywhere' }}
            >
              {headline.title}
            </span>
            {headline.body ? <span style={{ fontSize: 15, lineHeight: 1.5, color: lf.text2 }}>{headline.body}</span> : null}
          </Stack>
        </Row>
      </Panel>

      <Grid min={300} gap={18}>
        <Panel>
          <Stack gap={14}>
            <SectionLabel>{t('hushle.ended.finalScores')}</SectionLabel>
            {ranked.length > 0 ? (
              <Scoreboard
                label={t('hushle.ended.finalScores')}
                rows={ranked.map((team) => ({
                  id: team.id,
                  name: team.name,
                  score: team.score,
                  highlight: decided && team.score === top?.score,
                  detail: t('hushle.ended.teamDetail', {
                    correct: team.correctCount,
                    pass: team.passCount,
                    penalty: team.penaltyCount,
                  }),
                }))}
              />
            ) : (
              <span style={{ fontSize: 14, color: lf.muted }}>{t('hushle.ended.noTeams')}</span>
            )}
          </Stack>
        </Panel>
        <Panel>
          <Stack gap={14}>
            <SectionLabel>{t('hushle.ended.recap')}</SectionLabel>
            {/* Two by two at any width: four numbers never split three and one. */}
            <Grid min={120} gap={16} style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              <Stat label={t('hushle.ended.statPlayed')} value={totals.played} />
              <Stat label={t('hushle.ended.statGuessed')} value={totals.guessed} tone="success" />
              <Stat label={t('hushle.ended.statSkipped')} value={totals.skipped} />
              <Stat label={t('hushle.ended.statBusted')} value={totals.busted} tone="danger" />
            </Grid>
          </Stack>
        </Panel>
      </Grid>

      {!isHost ? <Callout role="status">{t('hushle.ended.waiting')}</Callout> : null}
    </>
  );
}
