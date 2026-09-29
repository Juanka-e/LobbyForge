/**
 * React glue for the panel. Everything that decides something lives in
 * pure modules (sync.ts, controller.ts, player-protocol.ts); these hooks
 * only connect them to time, the DOM and `dispatch`.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SyncController } from './controller';
import { commandMessage, listeningMessage, parsePlayerMessage, type PlayerCommand } from './player-protocol';
import type { WatchPartyClientAction } from './reducer';
import type { WatchPartyViewerStatus } from './state';
import { addClockSample, clockSample, estimateClockOffset, statusReportDecision, type ClockSample } from './sync';
import { YOUTUBE_EMBED_ORIGIN } from './youtube';

export type Send = (action: WatchPartyClientAction) => void;

/**
 * Server clock minus this machine's clock, learned from the server's
 * `stampedAt` as changes ARRIVE (see sync.ts). The state a panel mounts
 * with is not a sample — it may be minutes old — so the estimate starts
 * at 0 and improves with the first change (this panel's own join or
 * readiness report is one).
 */
export function useClockOffset(stampedAt: number): number {
  const samples = useRef<ClockSample[]>([]);
  const previous = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const seen = previous.current;
    previous.current = stampedAt;
    if (seen === null || seen === stampedAt) return;
    const now = Date.now();
    samples.current = addClockSample(samples.current, clockSample(stampedAt, now), now);
    setOffset(estimateClockOffset(samples.current));
  }, [stampedAt]);
  return offset;
}

/** Wait before joining, so a mount that is immediately undone costs nothing. */
const JOIN_DELAY_MS = 400;
/** Wait before leaving, so an unmount that is immediately redone costs nothing. */
const LEAVE_DELAY_MS = 300;

/**
 * A leave scheduled by an unmount, cancelled by a remount of the same
 * viewer. React's StrictMode mounts, unmounts and remounts every effect in
 * development — without this, the creator of a party would "leave" (and
 * hand the host to someone else) the moment their panel appeared.
 */
let pendingLeave: { userId: string; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Being on the watching list: join when the panel opens (unless already
 * listed or the list is full), leave when it closes. A closed tab sends
 * nothing — heartbeats (see useStatusReporter) let the others notice.
 */
export function usePresence(input: { me: string; listed: boolean; hasRoom: boolean; send: Send }): void {
  const latest = useRef(input);
  latest.current = input;
  const { me } = input;
  useEffect(() => {
    if (!me) return;
    if (pendingLeave?.userId === me) {
      clearTimeout(pendingLeave.timer);
      pendingLeave = null;
    }
    let joined = false;
    const timer = setTimeout(() => {
      if (!latest.current.listed && latest.current.hasRoom) {
        joined = true;
        latest.current.send({ type: 'join' });
      }
    }, JOIN_DELAY_MS);
    return () => {
      clearTimeout(timer);
      if (!joined && !latest.current.listed) return;
      const { send } = latest.current;
      const leaveTimer = setTimeout(() => {
        pendingLeave = null;
        send({ type: 'leave' });
      }, LEAVE_DELAY_MS);
      pendingLeave = { userId: me, timer: leaveTimer };
    };
  }, [me]);
}

/**
 * Tells the room this viewer's readiness — on change, debounced and
 * spaced out, plus the heartbeat (the rules are `statusReportDecision`).
 * One timer, one pure decision a second; an action only when it says so.
 */
export function useStatusReporter(input: {
  desired: WatchPartyViewerStatus | null;
  serverStatus: WatchPartyViewerStatus | undefined;
  isHost: boolean;
  canBeListed: boolean;
  send: Send;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const desiredSince = useRef<{ value: WatchPartyViewerStatus | null; since: number }>({
    value: input.desired,
    since: Date.now(),
  });
  // Opening the panel joined (or was already listed): that counts as said.
  const lastSentAt = useRef(Date.now());

  useEffect(() => {
    if (desiredSince.current.value !== input.desired) {
      desiredSince.current = { value: input.desired, since: Date.now() };
    }
  }, [input.desired]);

  useEffect(() => {
    const check = () => {
      const current = latest.current;
      const now = Date.now();
      const decision = statusReportDecision({
        desired: current.desired,
        serverStatus: current.serverStatus,
        desiredSince: desiredSince.current.since,
        lastSentAt: lastSentAt.current,
        now,
        isHost: current.isHost,
        canBeListed: current.canBeListed,
      });
      if (!decision.send) return;
      lastSentAt.current = now;
      current.send({ type: 'report-status', status: decision.status });
    };
    const id = setInterval(check, 1_000);
    return () => clearInterval(id);
  }, []);
}

/** How long the 'listening' handshake is repeated before giving up (the view then says the player is stalled). */
const HANDSHAKE_INTERVAL_MS = 250;
const HANDSHAKE_ATTEMPTS = 120;

/**
 * Connects the controller to the iframe for `itemKey`: the 'listening'
 * handshake, commands out, messages in. Every message is checked for BOTH
 * the player's origin and our own iframe as its source before it is
 * parsed — another frame, extension or tab cannot drive the controller.
 */
export function usePlayerBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  itemKey: string | null,
  frameShown: boolean,
  controller: SyncController,
  senderRef: { current: ((func: PlayerCommand, args: unknown[]) => void) | null }
): void {
  useEffect(() => {
    if (!itemKey || !frameShown) return;
    const widgetId = Math.floor(Math.random() * 1_000_000_000) + 1;
    let connected = false;
    let attempts = 0;
    const post = (message: string) => {
      // Addressed to the player's origin only: if the frame is anything
      // else (still blank, navigated away), the browser drops it.
      frameRef.current?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);
    };
    senderRef.current = (func, args) => post(commandMessage(func, args, widgetId));

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== YOUTUBE_EMBED_ORIGIN) return;
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parsePlayerMessage(event.data);
      if (!message) return;
      if (!connected) {
        connected = true;
        // State changes and errors are only sent to listeners that asked.
        post(commandMessage('addEventListener', ['onStateChange'], widgetId));
        post(commandMessage('addEventListener', ['onError'], widgetId));
      }
      if (message.kind === 'listen-again') post(listeningMessage(widgetId));
      controller.onMessage(message);
    };
    window.addEventListener('message', onMessage);

    const handshake = setInterval(() => {
      attempts += 1;
      if (connected || attempts > HANDSHAKE_ATTEMPTS) {
        clearInterval(handshake);
        return;
      }
      post(listeningMessage(widgetId));
    }, HANDSHAKE_INTERVAL_MS);
    const frame = frameRef.current;
    const onLoad = () => {
      if (!connected) post(listeningMessage(widgetId));
    };
    frame?.addEventListener('load', onLoad);

    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(handshake);
      frame?.removeEventListener('load', onLoad);
      senderRef.current = null;
    };
  }, [itemKey, frameShown, frameRef, controller, senderRef]);
}

/** True when the page has already had a click or key press — then a video may start with sound. */
export function pageHasUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
  return activation?.hasBeenActive === true;
}
