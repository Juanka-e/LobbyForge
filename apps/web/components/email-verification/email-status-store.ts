'use client';

import { createContext, createElement, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { isEmailUnverified, needsVerification, parseEmailStatus, type EmailStatus } from './email-status';

/**
 * One copy of `GET /api/auth/email/status` per tab, shared by everything
 * that reflects it — the banner, the composer, the voice list, the admin
 * forms — without a required provider: those live in different layouts
 * (the lobby, the settings modal, the hub). Pages that already read the
 * status on the server wrap their tree in `EmailStatusSeed` (below).
 *
 * While an unverified (or changing) address is on screen, the status is
 * read again whenever the tab comes back into view, so a link opened on
 * the phone unlocks the desktop tab without a reload.
 */

export const EMAIL_STATUS_ENDPOINT = '/api/auth/email/status';

interface StoreState {
  status: EmailStatus | null;
  /** A read finished (successfully or not) at least once. */
  loaded: boolean;
}

const EMPTY: StoreState = { status: null, loaded: false };

let state: StoreState = EMPTY;
let inflight: Promise<EmailStatus | null> | null = null;
let lastReadAt = 0;
let consumers = 0;
const listeners = new Set<() => void>();

/** Do not re-read more often than this on focus (focus + visibilitychange fire together). */
const FOCUS_REFRESH_GAP_MS = 2_000;

function emit(next: StoreState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;
const getServerSnapshot = () => EMPTY;

/** Read the status now (one request at a time, shared by every caller). */
export function refreshEmailStatus(): Promise<EmailStatus | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch(EMAIL_STATUS_ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) {
        emit({ status: null, loaded: true });
        return null;
      }
      const parsed = response.ok ? parseEmailStatus(await response.json().catch(() => null)) : null;
      // A failed read keeps what we knew: a blip must not unlock or hide anything.
      emit({ status: parsed ?? state.status, loaded: true });
      return parsed;
    } catch {
      emit({ status: state.status, loaded: true });
      return null;
    } finally {
      lastReadAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** Take an answer we already have (a server-rendered status, a send's new cooldown). */
export function setEmailStatus(status: EmailStatus | null) {
  emit({ status, loaded: true });
}

/** Patch the current status, if there is one. */
export function patchEmailStatus(patch: Partial<EmailStatus>) {
  if (!state.status) return;
  emit({ status: { ...state.status, ...patch }, loaded: true });
}

/**
 * The server refused an action with `email_unverified`: show the lock at
 * once (the server is the authority), then read the real status.
 */
export function noteEmailUnverifiedRefusal() {
  if (state.status) patchEmailStatus({ restricted: true, verified: false });
  void refreshEmailStatus();
}

/**
 * True when a response is the server's `email_unverified` refusal; the
 * shared status then flips to restricted so every control locks.
 */
export function handleEmailUnverified(httpStatus: number, body: unknown): boolean {
  if (!isEmailUnverified(httpStatus, body)) return false;
  noteEmailUnverifiedRefusal();
  return true;
}

function worthRereading(): boolean {
  if (!state.loaded) return true;
  // Nothing to unlock: a verified address with no change on its way.
  return needsVerification(state.status) || Boolean(state.status?.pendingChange);
}

function onComeBack() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (Date.now() - lastReadAt < FOCUS_REFRESH_GAP_MS) return;
  if (worthRereading()) void refreshEmailStatus();
}

function attachFocusListeners() {
  window.addEventListener('focus', onComeBack);
  document.addEventListener('visibilitychange', onComeBack);
}

function detachFocusListeners() {
  window.removeEventListener('focus', onComeBack);
  document.removeEventListener('visibilitychange', onComeBack);
}

/**
 * A status the server already read for this request (the lobby, the hub).
 * Every `useEmailStatus` below it starts from it — the banner, the
 * composer, the voice list — so the first paint already shows the locks,
 * instead of the controls flipping once a client fetch comes back. A
 * React context, not the module store: on the server the module is shared
 * by every request.
 */
const EmailStatusSeedContext = createContext<EmailStatus | null | undefined>(undefined);

export function EmailStatusSeed({ status, children }: { status: EmailStatus | null | undefined; children: ReactNode }) {
  return createElement(EmailStatusSeedContext.Provider, { value: status }, children);
}

export interface UseEmailStatusResult {
  status: EmailStatus | null;
  loaded: boolean;
  refresh: () => Promise<EmailStatus | null>;
}

/**
 * The account's email status. `enabled: false` (signed out, a guest)
 * makes no request and answers null. `initial` seeds the store with a
 * status the server already rendered, so nothing jumps in after load.
 */
export function useEmailStatus({
  enabled = true,
  initial,
}: { enabled?: boolean; initial?: EmailStatus | null } = {}): UseEmailStatusResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const seed = useContext(EmailStatusSeedContext);
  const start = initial !== undefined ? initial : seed;
  // Until the store has an answer, a server-rendered status stands in — on
  // the server, during hydration and after it — so the first paint and the
  // hydrated tree agree and nothing jumps in. (The store itself is never
  // written during render: on the server it is shared by every request.)
  const seeded = start !== undefined;
  const status = snapshot.loaded ? snapshot.status : seeded ? start : null;

  useEffect(() => {
    if (!enabled) return;
    if (!state.loaded && !inflight) {
      if (seeded) {
        lastReadAt = Date.now();
        emit({ status: start ?? null, loaded: true });
      } else {
        void refreshEmailStatus();
      }
    }
    consumers += 1;
    if (consumers === 1) attachFocusListeners();
    return () => {
      consumers -= 1;
      if (consumers === 0) detachFocusListeners();
    };
    // `start` only seeds the first read; later renders do not re-seed.
  }, [enabled]);

  const refresh = useCallback(() => refreshEmailStatus(), []);
  return {
    status: enabled ? status ?? null : null,
    loaded: enabled ? snapshot.loaded || seeded : true,
    refresh,
  };
}

/**
 * "Verify email" from anywhere: if the banner is on screen it takes the
 * request (scrolls to and focuses its code field) and this returns true;
 * otherwise the caller opens its own dialog.
 */
export const VERIFY_EMAIL_REQUEST_EVENT = 'lf:verify-email-request';

export function requestVerificationFocus(): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent(VERIFY_EMAIL_REQUEST_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Tests only: forget everything between cases. */
export function __resetEmailStatusStoreForTests() {
  state = EMPTY;
  inflight = null;
  lastReadAt = 0;
  if (consumers > 0 && typeof window !== 'undefined') detachFocusListeners();
  consumers = 0;
  listeners.clear();
}
