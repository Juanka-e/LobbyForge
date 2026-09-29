import { useId, useState } from 'react';
import { Button, Panel, Row, SectionLabel, Stack, lf } from '@lobbyforge/plugin-sdk/ui';
import type { VillageAction } from '../state';
import type { VillageView } from '../view';
import { NEXT_PHASE } from './labels';
import { TimerSettings } from './LobbyView';
import { useText } from './text';

type Dispatch = (action: VillageAction) => void;

/**
 * The host's table controls while a game runs (spec §20, MVP): move to the
 * next phase, pause, add time, change the timers, remove a player, end
 * the game. The host sees exactly what their seat lets them see — these
 * controls never reveal a role.
 */
export function HostControls({ view, dispatch }: { view: VillageView; dispatch: Dispatch }) {
  const { t } = useText();
  const selectId = useId();
  const [confirming, setConfirming] = useState(false);
  const [removeId, setRemoveId] = useState('');
  const next = NEXT_PHASE[view.phase];
  const paused = view.pausedRemainingMs !== null;
  const living = view.players.filter((p) => p.alive);
  const removable = living.some((p) => p.id === removeId) ? removeId : '';

  return (
    <section aria-label={t('vampire.host.title')}>
      <Panel variant="outline" padding={16}>
        <Stack gap={12}>
          <SectionLabel>{t('vampire.host.title')}</SectionLabel>
          <Row gap={8} wrap>
            {next ? (
              <Button onClick={() => dispatch({ type: 'advance', phaseId: view.phaseId })}>{t(next)}</Button>
            ) : null}
            {paused ? (
              <Button variant="secondary" onClick={() => dispatch({ type: 'resume' })}>
                {t('vampire.host.resume')}
              </Button>
            ) : (
              <Button variant="secondary" disabled={!view.phaseEndsAt} onClick={() => dispatch({ type: 'pause' })}>
                {t('vampire.host.pause')}
              </Button>
            )}
            <Button variant="secondary" title={t('vampire.host.addTimeAria')} onClick={() => dispatch({ type: 'extend', seconds: 30 })}>
              {t('vampire.host.addTime')}
            </Button>
            {!confirming ? (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                {t('vampire.host.endGame')}
              </Button>
            ) : null}
          </Row>
          {confirming ? (
            <Row gap={8} wrap>
              <span role="alert" style={{ fontSize: 14 }}>
                {t('vampire.host.endConfirm')}
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  dispatch({ type: 'end-game' });
                }}
              >
                {t('vampire.host.endYes')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t('vampire.lobby.cancel')}
              </Button>
            </Row>
          ) : null}
          {living.length > 0 ? (
            <Row gap={8} wrap align="flex-end">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px', minWidth: 0 }}>
                <label htmlFor={selectId} style={{ fontSize: 13, color: lf.text2 }}>
                  {t('vampire.host.removeLabel')}
                </label>
                <select id={selectId} className="vv-input lfui-focus" value={removable} onChange={(e) => setRemoveId(e.target.value)}>
                  <option value="">—</option>
                  {living.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="danger"
                disabled={!removable}
                onClick={() => {
                  if (!removable) return;
                  dispatch({ type: 'kick', targetId: removable });
                  setRemoveId('');
                }}
              >
                {t('vampire.host.remove')}
              </Button>
            </Row>
          ) : null}
          <details>
            <summary className="lfui-focus" style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {t('vampire.host.timers')}
            </summary>
            <div style={{ marginTop: 12 }}>
              <TimerSettings view={view} dispatch={dispatch} editable title={t('vampire.lobby.timers')} />
            </div>
          </details>
        </Stack>
      </Panel>
    </section>
  );
}
