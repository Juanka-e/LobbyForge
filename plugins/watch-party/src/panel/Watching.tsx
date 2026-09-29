/**
 * "Watching": who has the party open and whether their player keeps up.
 * Status is always words ("In sync", "Buffering", "Not synced", "Away"),
 * coloured as a second cue — never colour alone.
 *
 * Host tools live here because they are about people: the host hands the
 * party to someone; anyone may take over a host who has gone quiet; the
 * person who started the session can always take the controls back.
 */

import { Avatar, Badge, Button, Callout, Panel, Row, SectionLabel, Stack, lf, tone } from '@lobbyforge/plugin-sdk/ui';
import { findViewer, isHostAway, isViewerAway, type WatchPartyClientAction } from '../reducer';
import type { WatchPartyState, WatchPartyViewer } from '../state';
import type { Translate } from './types';

export function Watching({
  t,
  state,
  me,
  serverNow,
  displayName,
  knownName,
  isHost,
  isSessionCreator,
  send,
}: {
  t: Translate;
  state: WatchPartyState;
  me: string;
  /** Server time on this machine's estimate, in ms. */
  serverNow: number;
  displayName: (userId: string) => string;
  knownName: (userId: string) => string | null;
  isHost: boolean;
  isSessionCreator: boolean;
  send: (action: WatchPartyClientAction) => void;
}) {
  const hostAway = isHostAway(state, serverNow);
  const listed = findViewer(state, me) !== undefined;
  const playing = state.current !== null && state.playback.status === 'playing';

  return (
    <Panel padding={16} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionLabel>{t('watchParty.viewers.title')}</SectionLabel>

      {hostAway && listed && !isHost ? (
        <Callout tone="game">
          <Stack gap={10}>
            <span>{state.hostId === null ? t('watchParty.host.none') : t('watchParty.host.away')}</span>
            <Row>
              <Button variant="game" size="sm" onClick={() => send({ type: 'claim-host' })}>
                {t('watchParty.host.claim')}
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}

      {state.viewers.length === 0 ? (
        <span style={{ fontSize: 14, color: lf.muted }}>{t('watchParty.viewers.empty')}</span>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.viewers.map((viewer) => {
            const isThisHost = state.hostId === viewer.userId;
            const away = isThisHost ? hostAway : isViewerAway(viewer, serverNow);
            const self = viewer.userId === me;
            const known = knownName(viewer.userId);
            const label = self
              ? known
                ? t('watchParty.viewers.you', { name: known })
                : t('watchParty.viewers.youOnly')
              : displayName(viewer.userId);
            return (
              <li key={viewer.userId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, opacity: away ? 0.6 : 1 }}>
                <Avatar name={known ?? displayName(viewer.userId)} size={28} />
                <span
                  style={{ flex: '1 1 90px', minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {label}
                </span>
                {isThisHost ? <Badge tone="game">{t('watchParty.viewers.host')}</Badge> : null}
                <ViewerStatus t={t} viewer={viewer} away={away} playing={playing} />
                {isHost && !self && !away ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('watchParty.viewers.makeHostLabel', { name: displayName(viewer.userId) })}
                    onClick={() => send({ type: 'transfer-host', toUserId: viewer.userId })}
                    style={{ minHeight: 30, padding: '0 10px', fontSize: 13 }}
                  >
                    {t('watchParty.viewers.makeHost')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {isSessionCreator && !isHost ? (
        <Row>
          <Button variant="ghost" size="sm" onClick={() => send({ type: 'take-host' })}>
            {t('watchParty.host.takeBack')}
          </Button>
        </Row>
      ) : null}
    </Panel>
  );
}

function ViewerStatus({
  t,
  viewer,
  away,
  playing,
}: {
  t: Translate;
  viewer: WatchPartyViewer;
  away: boolean;
  playing: boolean;
}) {
  if (away) return <span style={{ fontSize: 12, color: lf.muted }}>{t('watchParty.viewers.away')}</span>;
  if (viewer.status === 'ready') {
    return (
      <span style={{ fontSize: 12, color: tone('success').text }}>
        {playing ? t('watchParty.viewers.inSync') : t('watchParty.viewers.ready')}
      </span>
    );
  }
  if (viewer.status === 'buffering') {
    return <span style={{ fontSize: 12, color: tone('game').text }}>{t('watchParty.viewers.buffering')}</span>;
  }
  return <span style={{ fontSize: 12, color: lf.muted }}>{t('watchParty.viewers.idle')}</span>;
}
