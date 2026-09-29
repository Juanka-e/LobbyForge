'use client';

import { Callout, EmptyState, Panel, PlayerChip, Row, SectionLabel, Stack, lf } from '@lobbyforge/plugin-sdk/ui';
import type { ViewProps } from './context';
import { JoinBar } from './JoinBar';
import { SetupForm } from './SetupForm';

const PeopleIcon = (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M17 8v6M14 11h6" />
  </svg>
);

/** Before the start: who is in, and — for the host — the setup. */
export function LobbyView({ state, ui }: ViewProps) {
  const { t } = ui;
  const players = state.players.filter((player) => player.active);
  const iAmPlaying = players.some((player) => player.id === ui.me);

  const roster = (
    <Panel>
      <Stack gap={14}>
        <Row justify="space-between" wrap gap={8}>
          <SectionLabel>{t('quiz.lobby.playersTitle')}</SectionLabel>
          <span style={{ fontSize: 13, color: lf.text2 }}>{t('quiz.lobby.playerCount', { count: players.length })}</span>
        </Row>
        {players.length === 0 ? (
          <EmptyState icon={PeopleIcon} title={t('quiz.lobby.noPlayersTitle')} body={t('quiz.lobby.noPlayersBody')} />
        ) : (
          <ul aria-label={t('quiz.lobby.playersTitle')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {players.map((player) => {
              const mine = player.id === ui.me;
              const host = player.id === ui.hostId;
              return (
                <li key={player.id} style={{ maxWidth: '100%' }}>
                  <PlayerChip
                    name={ui.nameOf(player.id)}
                    tag={mine ? t('quiz.player.youTag') : host ? t('quiz.player.hostTag') : undefined}
                    tagTone={mine ? 'accent' : 'game'}
                    highlight={mine ? 'accent' : undefined}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <JoinBar ui={ui} playing={iAmPlaying} />
        {iAmPlaying ? null : <span style={{ fontSize: 13, color: lf.muted }}>{t('quiz.lobby.spectatorHint')}</span>}
      </Stack>
    </Panel>
  );

  if (ui.isHost) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
          gap: 18,
          alignItems: 'start',
        }}
      >
        <SetupForm ui={ui} playerCount={players.length} hostIsPlaying={iAmPlaying} />
        {roster}
      </div>
    );
  }

  return (
    <Stack gap={16}>
      <Callout tone="info" role="status">
        {ui.hostName ? t('quiz.lobby.waitingForHost', { name: ui.hostName }) : t('quiz.lobby.waitingForAnyHost')}
      </Callout>
      {roster}
    </Stack>
  );
}
