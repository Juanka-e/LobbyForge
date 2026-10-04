'use client';

import { useSyncExternalStore } from 'react';
import { INTERACTION_TTL_MS } from './client-api';

/**
 * What the invoker's browser knows about the commands they ran, and the
 * answers only they can see (BOT_API_V2 §3.4). Lives in memory for the
 * page: nothing here is stored, so ephemeral answers are gone on reload,
 * exactly as the contract says.
 *
 * - `pending`: "<bot> is thinking…" until the public answer arrives in the
 *   channel (matched by `metadata.interaction.id`) or an ephemeral one on
 *   `user:{uid}`; at `expiresAt` it turns into "<bot> did not respond".
 * - `ephemerals`: answers shown inline in their channel, "Only you can see
 *   this · Dismiss".
 */

export interface LocalInteraction {
  id: string;
  serverId: string;
  channelId: string;
  botId: string | null;
  botName: string;
  commandName: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'expired' | 'failed';
}

export interface EphemeralAnswer {
  key: string;
  interactionId: string;
  serverId: string | null;
  channelId: string;
  botName: string;
  commandName: string | null;
  content: string;
  createdAt: string;
}

export interface InteractionAnnouncement {
  /** Increments on every announcement so a repeated sentence is read again. */
  seq: number;
  kind: 'pending' | 'expired' | 'ephemeral' | 'answered';
  botName: string;
}

export interface InteractionState {
  interactions: LocalInteraction[];
  ephemerals: EphemeralAnswer[];
  announcement: InteractionAnnouncement | null;
}

const EMPTY: InteractionState = { interactions: [], ephemerals: [], announcement: null };
/** Answers seen before their pending row existed (an answer can beat the 202). */
const ANSWERED_MEMORY = 200;

let state: InteractionState = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const answered: string[] = [];

function emit(next: InteractionState) {
  state = next;
  for (const listener of listeners) listener();
}

function announce(kind: InteractionAnnouncement['kind'], botName: string): InteractionAnnouncement {
  seq += 1;
  return { seq, kind, botName };
}

function rememberAnswered(id: string) {
  if (answered.includes(id)) return;
  answered.push(id);
  if (answered.length > ANSWERED_MEMORY) answered.shift();
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export const interactionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): InteractionState {
    return state;
  },

  /** A command was accepted (202): show the pending row until an answer or expiry. */
  addPending(input: Omit<LocalInteraction, 'status' | 'expiresAt' | 'createdAt'> & { createdAt?: string; expiresAt?: string | null }) {
    if (answered.includes(input.id) || state.interactions.some((i) => i.id === input.id)) return;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(createdAt) + INTERACTION_TTL_MS).toISOString();
    const row: LocalInteraction = { ...input, createdAt, expiresAt, status: 'pending' };
    emit({ ...state, interactions: [...state.interactions, row], announcement: announce('pending', row.botName) });
    const delay = Math.max(0, Date.parse(expiresAt) - Date.now());
    timers.set(row.id, setTimeout(() => interactionStore.markExpired(row.id), delay));
  },

  /** The bot answered (publicly or only to the invoker): the pending row goes. */
  markAnswered(id: string) {
    rememberAnswered(id);
    clearTimer(id);
    const row = state.interactions.find((i) => i.id === id);
    if (!row) return;
    emit({
      ...state,
      interactions: state.interactions.filter((i) => i.id !== id),
      announcement: row.status === 'pending' ? announce('answered', row.botName) : state.announcement,
    });
  },

  /** No answer in time: "<bot> did not respond". */
  markExpired(id: string, status: 'expired' | 'failed' = 'expired') {
    clearTimer(id);
    const row = state.interactions.find((i) => i.id === id);
    if (!row || row.status !== 'pending') return;
    emit({
      ...state,
      interactions: state.interactions.map((i) => (i.id === id ? { ...i, status } : i)),
      announcement: announce('expired', row.botName),
    });
  },

  addEphemeral(answer: Omit<EphemeralAnswer, 'botName' | 'commandName'> & { botName?: string | null; commandName?: string | null }) {
    if (state.ephemerals.some((e) => e.key === answer.key)) return;
    const pending = state.interactions.find((i) => i.id === answer.interactionId);
    const full: EphemeralAnswer = {
      ...answer,
      botName: answer.botName || pending?.botName || '',
      commandName: answer.commandName ?? pending?.commandName ?? null,
    };
    rememberAnswered(answer.interactionId);
    clearTimer(answer.interactionId);
    emit({
      interactions: state.interactions.filter((i) => i.id !== answer.interactionId),
      ephemerals: [...state.ephemerals, full],
      announcement: announce('ephemeral', full.botName),
    });
  },

  /** Dismiss an ephemeral answer, or a "did not respond" row. */
  dismiss(key: string) {
    clearTimer(key);
    emit({
      ...state,
      interactions: state.interactions.filter((i) => i.id !== key || i.status === 'pending'),
      ephemerals: state.ephemerals.filter((e) => e.key !== key),
    });
  },

  /** Tests only. */
  reset() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    answered.length = 0;
    seq = 0;
    state = EMPTY;
    for (const listener of listeners) listener();
  },
};

export function useInteractionState(): InteractionState {
  return useSyncExternalStore(interactionStore.subscribe, interactionStore.getSnapshot, () => EMPTY);
}
