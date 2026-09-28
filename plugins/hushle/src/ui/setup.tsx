'use client';

import { useState, type FormEvent } from 'react';
import {
  Button,
  Callout,
  EmptyState,
  Grid,
  Panel,
  PhasePill,
  PlayerChip,
  Row,
  SectionLabel,
  Stack,
  Stat,
  lf,
  tone,
} from '@lobbyforge/plugin-sdk/ui';
import type { HushleSettings, HushleTeam } from '../state';
import { languageName, useHushleI18n } from './i18n';
import { playerName, presetName } from './labels';
import {
  draftOf,
  presetFor,
  seatedIds,
  setTeamsAction,
  splitIntoTeams,
  withPlayerAdded,
  withPlayerRemoved,
  withoutTeam,
  type TeamDraft,
} from './model';
import { CloseIcon, EmptySeat, PeopleIcon, TextField } from './parts';
import { HushleHeader, YouMark, isHostViewer, type ViewProps } from './shared';
import { teamTone } from './theme';

/**
 * Team setup. The host seats the people in the room by name — or splits
 * them into two teams in one go — and can adjust from there. `set-teams`
 * replaces the whole roster, so every edit sends the full list again.
 */
export function TeamSetupView(props: ViewProps) {
  const { t, locale } = useHushleI18n();
  const { state, dispatch, players, present, actorUserId, hostUserId } = props;
  const isHost = isHostViewer(props);
  const teamSize = Math.max(1, state.settings.teamSize);
  const seated = seatedIds(state);
  // Waiting to be seated: the people in the room who are on no team.
  const bench = players.filter((player) => present.has(player.userId) && !seated.has(player.userId));
  const firstTeam = state.teams[0] ?? null;
  const canStart = firstTeam !== null;

  const send = (teams: TeamDraft[], floater: string | null = state.floaterPlayerId) =>
    void dispatch(setTeamsAction(teams, floater));

  const split = () => {
    const names: [string, string] = [
      state.teams[0]?.name ?? t('hushle.teamSetup.nameFirst'),
      state.teams[1]?.name ?? t('hushle.teamSetup.nameSecond'),
    ];
    const everyone = players.filter((player) => present.has(player.userId)).map((player) => player.userId);
    const { teams, floaterPlayerId } = splitIntoTeams(everyone, teamSize, names);
    send(teams, floaterPlayerId);
  };

  const startFirstTurn = () => {
    if (!firstTeam) return;
    void dispatch({
      type: 'start-turn',
      teamId: firstTeam.id,
      explainerId: firstTeam.playerIds[0] ?? null,
    });
  };

  const firstExplainer = firstTeam?.playerIds[0] ?? null;
  const hostHint =
    state.teams.length === 0
      ? t('hushle.teamSetup.noTeamsHint')
      : state.teams.length === 1 || !firstTeam || !firstExplainer
        ? t('hushle.teamSetup.hostPrompt')
        : t('hushle.teamSetup.ready', { team: firstTeam.name, name: playerName(players, firstExplainer, t) });
  const inRoom = players.filter((player) => present.has(player.userId)).length;

  return (
    <>
      <HushleHeader
        hostUserId={hostUserId}
        players={players}
        detail={
          typeof state.deckSize === 'number'
            ? t('hushle.header.deck', { language: languageName(state.settings.language, locale), count: state.deckSize })
            : null
        }
        status={<PhasePill tone="info">{t('hushle.phase.team_setup')}</PhasePill>}
        actions={
          isHost ? (
            <Button variant="primary" disabled={!canStart} onClick={startFirstTurn}>
              {t('hushle.teamSetup.startTurn')}
            </Button>
          ) : null
        }
      />

      {isHost ? <Callout tone="info">{hostHint}</Callout> : null}

      <SettingsSummary settings={state.settings} />

      {isHost || bench.length > 0 ? (
        <Panel radius={20}>
          <Stack gap={12}>
            <Row justify="space-between" wrap gap={12}>
              <SectionLabel>{t('hushle.teamSetup.bench')}</SectionLabel>
              {isHost ? (
                <Button variant="game" size="sm" disabled={inRoom < 2} onClick={split}>
                  {state.teams.length === 0 ? t('hushle.teamSetup.split') : t('hushle.teamSetup.reshuffle')}
                </Button>
              ) : null}
            </Row>
            {bench.length === 0 ? (
              <span style={{ fontSize: 13, color: lf.muted }}>{t('hushle.teamSetup.benchEmpty')}</span>
            ) : (
              bench.map((player) => {
                const name = playerName(players, player.userId, t);
                return (
                  <Row key={player.userId} wrap gap={8}>
                    <PlayerChip
                      name={name}
                      tag={player.userId === hostUserId ? t('hushle.player.host') : undefined}
                      tagTone="game"
                      highlight={player.userId === actorUserId ? 'accent' : undefined}
                      trailing={player.userId === actorUserId ? <YouMark /> : undefined}
                    />
                    {isHost
                      ? state.teams
                          .filter((team) => team.playerIds.length < teamSize)
                          .map((team) => (
                            <Button
                              key={team.id}
                              variant="secondary"
                              size="sm"
                              aria-label={t('hushle.teamSetup.addTo', { name, team: team.name })}
                              onClick={() => send(withPlayerAdded(state.teams, team.id, player.userId))}
                            >
                              {team.name}
                            </Button>
                          ))
                      : null}
                    {isHost && !state.floaterPlayerId && state.teams.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('hushle.teamSetup.makeFloater', { name })}
                        onClick={() => send(draftOf(state.teams), player.userId)}
                      >
                        {t('hushle.player.floater')}
                      </Button>
                    ) : null}
                  </Row>
                );
              })
            )}
          </Stack>
        </Panel>
      ) : null}

      {state.teams.length === 0 && !isHost ? (
        <EmptyState icon={<PeopleIcon />} title={t('hushle.teamSetup.emptyTeams')} body={t('hushle.teamSetup.waitingBody')} />
      ) : null}

      {state.teams.length > 0 || isHost ? (
        <Grid min={260} gap={16}>
          {state.teams.map((team, index) => (
            <SetupTeam
              key={team.id}
              team={team}
              index={index}
              teamSize={teamSize}
              isHost={isHost}
              {...props}
              onRemovePlayer={(userId) => send(withPlayerRemoved(state.teams, userId))}
              onRemoveTeam={() => send(withoutTeam(state.teams, team.id))}
            />
          ))}
          {isHost ? (
            <AddTeamForm {...props} onAdd={(name) => send([...draftOf(state.teams), { name, playerIds: [] }])} />
          ) : null}
        </Grid>
      ) : null}

      {state.floaterPlayerId ? (
        <Panel radius={20}>
          <Stack gap={12}>
            <SectionLabel>{t('hushle.player.floater')}</SectionLabel>
            <Row wrap gap={10}>
              <PlayerChip
                name={playerName(players, state.floaterPlayerId, t)}
                tag={t('hushle.player.floater')}
                tagTone="game"
                highlight={state.floaterPlayerId === actorUserId ? 'accent' : undefined}
                trailing={state.floaterPlayerId === actorUserId ? <YouMark /> : undefined}
              />
              {isHost ? (
                <Button variant="ghost" size="sm" onClick={() => send(draftOf(state.teams), null)}>
                  {t('hushle.teamSetup.removeFloater')}
                </Button>
              ) : null}
            </Row>
            <span style={{ fontSize: 13, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.board.floaterHint')}</span>
          </Stack>
        </Panel>
      ) : null}

      {!isHost ? <Callout role="status">{t('hushle.teamSetup.waiting')}</Callout> : null}
    </>
  );
}

/** The settings the host picked in the lobby, for everyone to see. */
function SettingsSummary({ settings }: { settings: HushleSettings }) {
  const { t } = useHushleI18n();
  const preset = presetFor(settings.difficultyDistribution);
  return (
    <Panel padding={18} radius={20}>
      <Grid min={130} gap={16}>
        <Stat label={t('hushle.lobby.turnDuration')} value={t('hushle.settings.seconds', { count: settings.turnDurationSeconds })} />
        <Stat label={t('hushle.lobby.cardsPerTurn')} value={settings.cardsPerTurn} />
        <Stat label={t('hushle.lobby.teamSize')} value={settings.teamSize} />
        <Stat
          label={t('hushle.lobby.difficulty')}
          value={preset ? presetName(preset, t) : t('hushle.settings.difficultyCustom')}
        />
      </Grid>
    </Panel>
  );
}

function SetupTeam({
  team,
  index,
  teamSize,
  isHost,
  players,
  actorUserId,
  hostUserId,
  onRemovePlayer,
  onRemoveTeam,
}: ViewProps & {
  team: HushleTeam;
  index: number;
  teamSize: number;
  isHost: boolean;
  onRemovePlayer: (userId: string) => void;
  onRemoveTeam: () => void;
}) {
  const { t } = useHushleI18n();
  const colour = teamTone(index);
  const openSeats = Math.max(0, teamSize - team.playerIds.length);
  return (
    <Panel radius={20} highlight={team.playerIds.includes(actorUserId) ? colour : undefined}>
      <Stack gap={14}>
        <Row justify="space-between" gap={8}>
          <span style={{ fontSize: 16, fontWeight: 600, color: tone(colour).text, overflowWrap: 'anywhere', minWidth: 0 }}>
            {team.name}
          </span>
          {isHost ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('hushle.teamSetup.removeTeam', { team: team.name })}
              onClick={onRemoveTeam}
            >
              {t('hushle.teamSetup.remove')}
            </Button>
          ) : null}
        </Row>
        <SectionLabel>{t('hushle.teamSetup.seats', { count: team.playerIds.length, max: teamSize })}</SectionLabel>
        <Stack gap={8}>
          {team.playerIds.map((userId) => {
            const name = playerName(players, userId, t);
            return (
              <Row key={userId} gap={6}>
                <PlayerChip
                  name={name}
                  tag={userId === hostUserId ? t('hushle.player.host') : undefined}
                  tagTone="game"
                  highlight={userId === actorUserId ? 'accent' : undefined}
                  trailing={userId === actorUserId ? <YouMark /> : undefined}
                />
                {isHost ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('hushle.teamSetup.removePlayer', { name, team: team.name })}
                    onClick={() => onRemovePlayer(userId)}
                  >
                    <CloseIcon />
                  </Button>
                ) : null}
              </Row>
            );
          })}
          {Array.from({ length: openSeats }, (_, seat) => (
            <span key={`open-${seat}`}>
              <EmptySeat>{t('hushle.teamSetup.openSeat')}</EmptySeat>
            </span>
          ))}
        </Stack>
      </Stack>
    </Panel>
  );
}

/** A new, empty team; the host seats people on it from the room. */
function AddTeamForm({ state, onAdd }: ViewProps & { onAdd: (name: string) => void }) {
  const { t } = useHushleI18n();
  const [name, setName] = useState('');
  const canAdd = name.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    onAdd(name.trim());
    setName('');
  };

  return (
    <Panel variant="outline" radius={20}>
      <form onSubmit={submit} aria-label={t('hushle.teamSetup.addTeam')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionLabel>{t('hushle.teamSetup.newTeam')}</SectionLabel>
        <TextField
          label={t('hushle.teamSetup.teamName')}
          value={name}
          maxLength={40}
          autoComplete="off"
          placeholder={t('hushle.teamSetup.teamNamePlaceholder', { number: state.teams.length + 1 })}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!canAdd}>
          {t('hushle.teamSetup.addTeam')}
        </Button>
      </form>
    </Panel>
  );
}
