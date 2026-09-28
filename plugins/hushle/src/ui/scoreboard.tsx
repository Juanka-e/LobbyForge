'use client';

import { Badge, Grid, Panel, PlayerChip, Row, Stack, lf, tone, type Tone } from '@lobbyforge/plugin-sdk/ui';
import type { HushleTeam } from '../state';
import { useHushleI18n } from './i18n';
import { playerName } from './labels';
import type { HushleViewState, PanelPlayer } from './model';
import { VisuallyHidden } from './parts';
import { YouMark } from './shared';
import { DISPLAY_FONT, teamTone } from './theme';

/**
 * The teams during a game: each team's score, its players and what each of
 * them is doing this turn. The explaining team is tinted and labelled —
 * the tint alone would not say it.
 */
export function TeamBoard({
  state,
  players,
  actorUserId,
  hostUserId,
  showRoles,
}: {
  state: HushleViewState;
  players: PanelPlayer[];
  actorUserId: string;
  hostUserId: string | null;
  /** Tag players with this turn's job (explaining / guessing / watching). */
  showRoles: boolean;
}) {
  const { t } = useHushleI18n();
  const floater = state.floaterPlayerId;

  const tagFor = (team: HushleTeam, userId: string): { tag: string | undefined; tagTone: Tone } => {
    if (showRoles && state.currentExplainerId === userId) return { tag: t('hushle.board.explaining'), tagTone: 'game' };
    if (showRoles && state.currentTeamId) {
      return team.id === state.currentTeamId
        ? { tag: t('hushle.board.guessing'), tagTone: 'info' }
        : { tag: t('hushle.board.watching'), tagTone: 'neutral' };
    }
    if (userId === hostUserId) return { tag: t('hushle.player.host'), tagTone: 'game' };
    return { tag: undefined, tagTone: 'neutral' };
  };

  const displayName = (userId: string) => playerName(players, userId, t);
  const you = (userId: string) => (userId === actorUserId ? <YouMark /> : undefined);

  return (
    <section aria-label={t('hushle.playing.scores')}>
      <Stack gap={12}>
        <Grid min={220} gap={14}>
          {state.teams.map((team, index) => {
            const teamColour = teamTone(index);
            const explaining = showRoles && team.id === state.currentTeamId;
            return (
              <Panel key={team.id} highlight={explaining ? teamColour : undefined} padding={20} radius={22}>
                <Stack gap={12}>
                  <Row justify="space-between" align="baseline" gap={12}>
                    <Stack gap={6}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: tone(teamColour).text, overflowWrap: 'anywhere' }}>
                        {team.name}
                      </span>
                      {explaining ? (
                        <span>
                          <Badge tone={teamColour}>{t('hushle.board.theirTurn')}</Badge>
                        </span>
                      ) : null}
                    </Stack>
                    <span style={{ fontFamily: DISPLAY_FONT, fontSize: 40, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                      <span aria-hidden="true">{team.score}</span>
                      <VisuallyHidden>{t('hushle.board.points', { count: team.score })}</VisuallyHidden>
                    </span>
                  </Row>
                  {team.playerIds.length > 0 ? (
                    <Row wrap gap={8}>
                      {team.playerIds.map((userId) => {
                        const { tag, tagTone } = tagFor(team, userId);
                        return (
                          <PlayerChip
                            key={userId}
                            name={displayName(userId)}
                            tag={tag}
                            tagTone={tagTone}
                            highlight={userId === actorUserId ? 'accent' : showRoles && userId === state.currentExplainerId ? 'game' : undefined}
                            trailing={you(userId)}
                          />
                        );
                      })}
                    </Row>
                  ) : (
                    <span style={{ fontSize: 13, color: lf.muted }}>{t('hushle.board.noPlayers')}</span>
                  )}
                </Stack>
              </Panel>
            );
          })}
        </Grid>
        {floater ? (
          <Row wrap gap={10}>
            <PlayerChip
              name={displayName(floater)}
              tag={
                showRoles && state.currentExplainerId === floater
                  ? t('hushle.board.floaterExplaining')
                  : t('hushle.player.floater')
              }
              tagTone="game"
              highlight={floater === actorUserId ? 'accent' : undefined}
              trailing={you(floater)}
            />
            <span style={{ fontSize: 13, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.board.floaterHint')}</span>
          </Row>
        ) : null}
      </Stack>
    </section>
  );
}
