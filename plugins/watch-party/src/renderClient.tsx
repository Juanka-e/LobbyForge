/**
 * Watch Party panel — rendered by the host in the lobby's centre column
 * (and the voice room) while a watch party runs.
 *
 * Like every panel it has no HTTP of its own: each change is an action
 * through `dispatch`, and the host re-renders it with the next state. The
 * one thing it talks to directly is the YouTube player in its iframe, over
 * postMessage (see player-protocol.ts). The logic lives in pure modules —
 * sync.ts (the model), controller.ts (one viewer's player), reducer.ts
 * (the rules, reused here to explain refusals) — and this file wires them
 * to React. The layout follows the Watch Party artboard: header with the
 * room's sync status; player and controls; "Up next" and "Watching" in a
 * sidebar that drops below the player when the column is narrow.
 */

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { detectLocale, loadPluginLocale, pickBestLocale, tFor } from '@lobbyforge/plugin-sdk';
import { ActivityHeader, ActivityShell, EmptyState, PhasePill, lf, useNow, type Tone } from '@lobbyforge/plugin-sdk/ui';
import { POSITION_MAX_SEC, VIEWERS_MAX, WATCH_PARTY_PLUGIN_ID } from './constants';
import { SyncController } from './controller';
import {
  pageHasUserActivation,
  useClockOffset,
  usePlayerBridge,
  usePresence,
  useStatusReporter,
  type Send,
} from './hooks';
import { LOCALE_TABLES } from './locales.generated';
import { PLAYER_STATE, type PlayerCommand } from './player-protocol';
import {
  canControlPlayback,
  findViewer,
  isPartyHost,
  isViewerAway,
  type WatchPartyClientAction,
} from './reducer';
import { clampPosition, normalizeWatchPartyState } from './state';
import { expectedPositionSec, roomSummary, type RoomSummary } from './sync';
import { AddLinkForm } from './panel/AddLinkForm';
import { ScreenIcon } from './panel/icons';
import { PlayerStage } from './panel/PlayerStage';
import { Transport } from './panel/Transport';
import type { Translate } from './panel/types';
import { UpNext } from './panel/UpNext';
import { Watching } from './panel/Watching';

// Also registered by index.ts, which the server evaluates (the host reads
// `catalog.summary` there); this module is the one the browser runs.
loadPluginLocale(WATCH_PARTY_PLUGIN_ID, LOCALE_TABLES);

export interface WatchPartyPanelClientProps {
  /**
   * The party as the host delivers it. Typed loosely on purpose: the
   * realtime gateway forwards stored state without running
   * `migrateState`, so the panel normalises it itself.
   */
  state: unknown;
  dispatch: (action: WatchPartyClientAction) => void | Promise<unknown>;
  actorUserId: string;
  /** The session's CREATOR — who may always take the controls back. The party's host is `state.hostId`. */
  hostUserId: string | null;
  players: Array<{ userId: string; name?: string | null }>;
}

export type WatchPartyPanelProps = WatchPartyPanelClientProps;

/** How long ±10 s clicks are gathered into one seek for the room. */
const NUDGE_SETTLE_MS = 600;
/** A controller's own position is sent with "pause" only when it agrees with the room this closely. */
const TRUSTED_LOCAL_POSITION_SEC = 3;

function shortId(userId: string): string {
  return userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || '?';
}

function pillFor(summary: RoomSummary, t: Translate): { label: string; tone: Tone; live: boolean } {
  switch (summary.kind) {
    case 'empty':
      return { label: t('watchParty.pill.empty'), tone: 'neutral', live: false };
    case 'paused':
      return { label: t('watchParty.pill.paused'), tone: 'info', live: false };
    case 'synced':
      return { label: t('watchParty.pill.synced'), tone: 'success', live: true };
    case 'buffering':
      return { label: t('watchParty.pill.buffering', { count: summary.count }), tone: 'game', live: true };
    default:
      return { label: t('watchParty.pill.playing'), tone: 'success', live: true };
  }
}

export function WatchPartyPanel(props: WatchPartyPanelProps): ReactNode {
  const { actorUserId: me, players, hostUserId: sessionCreatorId } = props;
  const locale = useMemo(
    () => pickBestLocale(WATCH_PARTY_PLUGIN_ID, detectLocale('en')),
    // The document language does not change mid-session.
    []
  );
  const t = useCallback<Translate>((key, params) => tFor(WATCH_PARTY_PLUGIN_ID, locale, key, params), [locale]);
  const state = useMemo(() => normalizeWatchPartyState(props.state), [props.state]);
  const current = state.current;

  // `dispatch` is a fresh function on every host render; effects hold the latest.
  const dispatchRef = useRef(props.dispatch);
  dispatchRef.current = props.dispatch;
  const send = useCallback<Send>((action) => {
    void Promise.resolve(dispatchRef.current(action)).catch(() => {
      // The host reports failed actions under the panel.
    });
  }, []);

  // -- time: this machine's clock, corrected to the server's -----------------
  const offsetMs = useClockOffset(state.stampedAt);
  const serverNow = useNow(1_000) + offsetMs;

  // -- who am I in this party -------------------------------------------------
  const myViewer = findViewer(state, me);
  const isHost = isPartyHost(state, me);
  const canControl = canControlPlayback(state, me);
  const hasRoom = state.viewers.length < VIEWERS_MAX;
  usePresence({ me, listed: myViewer !== undefined, hasRoom, send });

  const knownName = useCallback(
    (userId: string): string | null => players.find((p) => p.userId === userId)?.name?.trim() || null,
    [players]
  );
  const displayName = useCallback(
    (userId: string): string => knownName(userId) ?? t('watchParty.viewers.fallbackName', { id: shortId(userId) }),
    [knownName, t]
  );

  // -- the player ------------------------------------------------------------------
  // The page origin is only read in the browser, after mount.
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const senderRef = useRef<((func: PlayerCommand, args: unknown[]) => void) | null>(null);
  const endedRef = useRef<(itemId: string, positionSec: number | null) => void>(() => undefined);
  endedRef.current = (itemId, positionSec) =>
    send(
      positionSec === null
        ? { type: 'video-ended', itemId }
        : { type: 'video-ended', itemId, positionSec: clampPosition(positionSec) }
    );
  const [controller] = useState(
    () =>
      new SyncController({
        now: () => Date.now(),
        send: (func, args) => senderRef.current?.(func, args),
        onEnded: (itemId, positionSec) => endedRef.current(itemId, positionSec),
        engaged: pageHasUserActivation(),
      })
  );
  useEffect(() => {
    controller.setRoom({
      itemId: current?.id ?? null,
      videoId: current?.videoId ?? null,
      playback: state.playback,
      offsetMs,
      isHost,
    });
  }, [controller, current?.id, current?.videoId, state.playback, offsetMs, isHost]);
  useEffect(() => {
    const id = setInterval(() => controller.tick(), 500);
    return () => clearInterval(id);
  }, [controller]);
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  usePlayerBridge(frameRef, current?.id ?? null, origin !== null, controller, senderRef);

  useStatusReporter({
    desired: view.status,
    serverStatus: myViewer?.status,
    isHost,
    canBeListed: myViewer !== undefined || hasRoom,
    send,
  });

  // -- controls (only rendered for people who may use them) -------------------
  const nudge = useRef<{ target: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flushNudge = useCallback(() => {
    const pending = nudge.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    nudge.current = null;
    send({ type: 'seek', positionSec: clampPosition(pending.target) });
  }, [send]);
  // A ±10 s click just before the panel closes still reaches the room.
  useEffect(() => flushNudge, [flushNudge]);

  const onPlay = () => {
    controller.localPlay();
    // No position: play resumes the room's timeline, wherever this player is.
    send({ type: 'play' });
  };
  const onPause = () => {
    const local = controller.currentTime();
    const trusted =
      local !== null && Math.abs(local - controller.expectedTime()) <= TRUSTED_LOCAL_POSITION_SEC ? local : null;
    controller.localPause();
    send(trusted === null ? { type: 'pause' } : { type: 'pause', positionSec: clampPosition(trusted) });
  };
  const onNudge = (deltaSec: number) => {
    const base = nudge.current?.target ?? controller.expectedTime();
    const target = Math.min(controller.duration() ?? POSITION_MAX_SEC, Math.max(0, base + deltaSec));
    controller.localSeek(target);
    if (nudge.current) clearTimeout(nudge.current.timer);
    nudge.current = { target, timer: setTimeout(flushNudge, NUDGE_SETTLE_MS) };
  };
  const onSeek = (toSec: number) => {
    controller.localSeek(toSec);
    send({ type: 'seek', positionSec: clampPosition(toSec) });
  };
  const onSyncToMe = () => {
    const local = controller.currentTime();
    if (local === null) return;
    controller.expectRoomChange();
    send({ type: 'seek', positionSec: clampPosition(local) });
  };
  const canSyncToMe =
    view.connected &&
    view.localTime !== null &&
    view.playerState !== null &&
    view.playerState !== PLAYER_STATE.UNSTARTED &&
    view.playerState !== PLAYER_STATE.CUED;

  // -- header --------------------------------------------------------------------
  const pill = pillFor(roomSummary(state, serverNow), t);
  const subtitle = [
    isHost
      ? t('watchParty.header.hosting')
      : state.hostId
        ? t('watchParty.header.hostedBy', { name: displayName(state.hostId) })
        : t('watchParty.header.noHost'),
  ];
  if (state.controlMode === 'everyone') subtitle.push(t('watchParty.header.everyoneControls'));
  const watching = state.viewers.filter((viewer) => !isViewerAway(viewer, serverNow)).length;
  const position = expectedPositionSec(state.playback, serverNow, view.duration);

  return (
    <ActivityShell role="region" aria-label={t('watchParty.title')}>
      <ActivityHeader
        glyph="W"
        tone="success"
        title={t('watchParty.title')}
        subtitle={subtitle.join(' · ')}
        status={
          <PhasePill tone={pill.tone} live={pill.live}>
            {pill.label}
          </PhasePill>
        }
        actions={<span style={{ fontSize: 14, color: lf.text2 }}>{t('watchParty.header.watching', { count: watching })}</span>}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 18 }}>
        <div style={{ flex: '999 1 440px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {current ? (
            <>
              <PlayerStage
                t={t}
                item={current}
                origin={origin}
                frameRef={frameRef}
                view={view}
                isHost={isHost}
                onJoin={() => controller.engage()}
              />
              <Transport
                t={t}
                canControl={canControl}
                isHost={isHost}
                hostName={state.hostId ? displayName(state.hostId) : null}
                roomStatus={state.playback.status}
                position={position}
                duration={view.duration}
                view={view}
                controlMode={state.controlMode}
                canSyncToMe={canSyncToMe}
                onPlay={onPlay}
                onPause={onPause}
                onNudge={onNudge}
                onSeek={onSeek}
                onSyncToMe={onSyncToMe}
                onEngage={() => controller.engage()}
                onModeChange={(mode) => send({ type: 'set-control-mode', mode })}
              />
            </>
          ) : (
            <EmptyState
              icon={<ScreenIcon />}
              title={t('watchParty.stage.emptyTitle')}
              body={t('watchParty.stage.emptyBody')}
              action={
                <div style={{ width: '100%', maxWidth: 440 }}>
                  <AddLinkForm t={t} state={state} me={me} isHost={isHost} send={send} />
                </div>
              }
            />
          )}
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: lf.muted }}>{t('watchParty.copyright')}</p>
        </div>

        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <UpNext t={t} state={state} me={me} isHost={isHost} nameOf={displayName} send={send} />
          <Watching
            t={t}
            state={state}
            me={me}
            serverNow={serverNow}
            displayName={displayName}
            knownName={knownName}
            isHost={isHost}
            isSessionCreator={Boolean(me) && sessionCreatorId === me}
            send={send}
          />
        </div>
      </div>
    </ActivityShell>
  );
}
