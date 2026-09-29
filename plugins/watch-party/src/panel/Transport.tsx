/**
 * Under the player: where the room is, the controls (for whoever may use
 * them), this viewer's own sync state, and — for the host — who else may
 * control playback.
 *
 * People who may not control see no buttons that would not work: they
 * get the timeline, a sentence saying who controls it, and "Resync my
 * player" (local only — it sends nothing to the room).
 */

import { useState, type CSSProperties } from 'react';
import { Button, Panel, ProgressBar, Row, SegmentedControl, lf } from '@lobbyforge/plugin-sdk/ui';
import type { SyncView } from '../controller';
import type { WatchPartyControlMode, WatchPartyPlaybackStatus } from '../state';
import { formatTime } from '../sync';
import { BackIcon, ForwardIcon, PauseIcon, PlayIcon, SyncIcon } from './icons';
import type { Translate } from './types';

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  color: lf.text2,
  fontVariantNumeric: 'tabular-nums',
  flexShrink: 0,
};
const SQUARE: CSSProperties = { width: 48, minHeight: 48, padding: 0, borderRadius: 14 };
const ROUND: CSSProperties = { width: 56, minHeight: 56, padding: 0, borderRadius: 99 };

export interface TransportProps {
  t: Translate;
  canControl: boolean;
  isHost: boolean;
  /** The host's display name, null when nobody hosts. */
  hostName: string | null;
  roomStatus: WatchPartyPlaybackStatus;
  /** The room's position on the shared timeline, in seconds. */
  position: number;
  duration: number | null;
  view: SyncView;
  controlMode: WatchPartyControlMode;
  canSyncToMe: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNudge: (deltaSec: number) => void;
  onSeek: (toSec: number) => void;
  onSyncToMe: () => void;
  onEngage: () => void;
  onModeChange: (mode: WatchPartyControlMode) => void;
}

export function Transport(props: TransportProps) {
  const { t, canControl, isHost, hostName, roomStatus, position, duration, view, controlMode } = props;
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;
  const max = Math.max(1, Math.floor(duration ?? position));
  const valueText = t('watchParty.controls.seekValue', { position: formatTime(shown), duration: formatTime(duration) });

  const commit = () => {
    if (scrub === null) return;
    props.onSeek(scrub);
    setScrub(null);
  };

  return (
    <Panel padding="16px 18px" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Row gap={12}>
        <span style={MONO}>{formatTime(shown)}</span>
        {canControl ? (
          <input
            type="range"
            min={0}
            max={max}
            step={1}
            value={Math.min(Math.floor(shown), max)}
            disabled={duration === null}
            aria-label={t('watchParty.controls.seek')}
            aria-valuetext={valueText}
            onChange={(event) => setScrub(Number(event.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="lfui-focus"
            style={{ flexGrow: 1, minWidth: 0, margin: 0, accentColor: 'var(--lfui-success)', cursor: duration === null ? 'default' : 'pointer' }}
          />
        ) : (
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <ProgressBar
              value={duration ? position / duration : 0}
              tone="success"
              label={t('watchParty.controls.progress')}
              valueText={valueText}
            />
          </div>
        )}
        <span style={MONO}>{formatTime(duration)}</span>
      </Row>

      {canControl ? (
        <Row gap={10} wrap>
          <Button
            variant="secondary"
            aria-label={t('watchParty.controls.back')}
            title={t('watchParty.controls.back')}
            onClick={() => props.onNudge(-10)}
            style={SQUARE}
          >
            <BackIcon />
          </Button>
          {roomStatus === 'playing' ? (
            <Button
              variant="success"
              aria-label={t('watchParty.controls.pause')}
              title={t('watchParty.controls.pause')}
              onClick={props.onPause}
              style={ROUND}
            >
              <PauseIcon />
            </Button>
          ) : (
            <Button
              variant="success"
              aria-label={t('watchParty.controls.play')}
              title={t('watchParty.controls.play')}
              onClick={props.onPlay}
              style={ROUND}
            >
              <PlayIcon />
            </Button>
          )}
          <Button
            variant="secondary"
            aria-label={t('watchParty.controls.forward')}
            title={t('watchParty.controls.forward')}
            onClick={() => props.onNudge(10)}
            style={SQUARE}
          >
            <ForwardIcon />
          </Button>
          <span style={{ fontSize: 14, color: lf.text2, marginLeft: 4 }}>{t('watchParty.controls.moveEveryone')}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={props.onSyncToMe}
            disabled={!props.canSyncToMe}
            style={{ marginLeft: 'auto' }}
          >
            <SyncIcon />
            {t('watchParty.controls.syncToMe')}
          </Button>
        </Row>
      ) : (
        <Row gap={10} wrap>
          <span style={{ fontSize: 14, color: lf.text2, flexGrow: 1, minWidth: 200 }}>
            {hostName
              ? t('watchParty.controls.viewerOnly', { name: hostName })
              : t('watchParty.controls.noHost')}
          </span>
          <Button variant="secondary" size="sm" onClick={props.onEngage} disabled={!view.connected}>
            <SyncIcon />
            {t('watchParty.controls.resync')}
          </Button>
        </Row>
      )}

      <LocalStatus t={t} view={view} roomStatus={roomStatus} position={position} onEngage={props.onEngage} />

      {isHost ? (
        <Row gap={10} wrap>
          <span style={{ fontSize: 13, color: lf.text2 }}>{t('watchParty.controls.controlMode')}</span>
          <SegmentedControl
            label={t('watchParty.controls.controlMode')}
            options={[
              { value: 'host' as const, label: t('watchParty.controls.modeHost') },
              { value: 'everyone' as const, label: t('watchParty.controls.modeEveryone') },
            ]}
            value={controlMode}
            onChange={props.onModeChange}
          />
        </Row>
      ) : null}
    </Panel>
  );
}

/** One line about THIS viewer's player — announced politely when it changes. */
function LocalStatus({
  t,
  view,
  roomStatus,
  position,
  onEngage,
}: {
  t: Translate;
  view: SyncView;
  roomStatus: WatchPartyPlaybackStatus;
  position: number;
  onEngage: () => void;
}) {
  if (view.error !== null) return null;
  let text: string;
  let tone: 'ok' | 'wait' | 'act' = 'wait';
  let action: { label: string; run: () => void } | null = null;
  if (!view.engaged) {
    text = t('watchParty.local.notJoined');
    tone = 'act';
    action = { label: t('watchParty.stage.joinButton'), run: onEngage };
  } else if (view.hold) {
    text = t('watchParty.local.hold');
    tone = 'act';
    action = { label: t('watchParty.local.resume'), run: onEngage };
  } else if (view.blocked) {
    text = t('watchParty.local.blocked');
    tone = 'act';
  } else if (!view.connected) {
    text = t('watchParty.local.loading');
  } else if (roomStatus === 'paused') {
    text = t('watchParty.local.paused', { time: formatTime(position) });
    tone = 'ok';
  } else if (view.inSync) {
    text = t('watchParty.local.inSync');
    tone = 'ok';
  } else {
    text = t('watchParty.local.syncing');
  }
  const dot = tone === 'ok' ? 'var(--lfui-success)' : tone === 'act' ? 'var(--lfui-game)' : 'var(--lfui-muted)';
  return (
    <Row gap={10} wrap>
      <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 99, background: dot, flexShrink: 0 }} />
        {text}
      </span>
      {action ? (
        <Button variant="ghost" size="sm" onClick={action.run}>
          {action.label}
        </Button>
      ) : null}
    </Row>
  );
}
