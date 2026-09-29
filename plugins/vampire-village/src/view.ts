/**
 * What a viewer actually receives, and the pure helpers the panel reads it with.
 *
 * `projectActivityState` in @lobbyforge/core (the web routes AND the
 * realtime gateway both run it) removes `state.secret` and hands each
 * viewer only their own slice as `me` — see packages/core/src/
 * activity-projection.ts and its vampire test. Once the game has ended the
 * whole `secret` block comes back for everyone.
 */
import type {
  VillageChatMessage,
  VillageLogEntry,
  VillageNightChoice,
  VillageNote,
  VillagePlayer,
  VillageResources,
  VillageRole,
  VillageSecret,
  VillageState,
} from './state';
import { CHAT_PER_PHASE, MIN_PLAYERS, PACK_CHAT_PER_PHASE } from './state';
import { HUNTER_FIRST_NIGHT, majorityNeeded } from './rules';

export interface VillagePack {
  /** Every vampire, dead ones included. */
  members: string[];
  /** Tonight's bite votes, by vampire. */
  votes: Record<string, string>;
  chat: VillageChatMessage[];
}

/** The viewer's own slice of the secrets; null for spectators and before the roles are dealt. */
export interface VillageMe {
  id: string;
  role: VillageRole;
  alive: boolean;
  notes: VillageNote[];
  resources: VillageResources;
  /** Tonight's choice (the living only). */
  choice: VillageNightChoice | null;
  /** Living vampires only. */
  pack: VillagePack | null;
}

export type VillageView = Omit<VillageState, 'secret'> & {
  me: VillageMe | null;
  /** Present only once the game has ended. */
  secret?: VillageSecret;
};

export type NightTask =
  | { kind: 'bite' }
  | { kind: 'inspect' }
  | { kind: 'protect'; blockedId: string | null }
  | { kind: 'shoot'; bullets: number }
  | { kind: 'hunter-waits' }
  | { kind: 'out-of-bullets' }
  | { kind: 'shield'; shields: number }
  | { kind: 'out-of-shields' }
  | { kind: 'sleep' }
  | { kind: 'dead' }
  | { kind: 'watch' };

const PUBLIC_CHAT_PHASES = new Set(['dawn', 'day', 'voting', 'verdict']);

export function livingPlayers(view: Pick<VillageView, 'players'>): VillagePlayer[] {
  return view.players.filter((p) => p.alive);
}

export function playerById(view: Pick<VillageView, 'players'>, id: string | null | undefined): VillagePlayer | undefined {
  return id ? view.players.find((p) => p.id === id) : undefined;
}

/** What the viewer has to do tonight — drives the night panel. */
export function nightTaskFor(view: VillageView): NightTask {
  const me = view.me;
  if (!me) return { kind: 'watch' };
  if (!me.alive) return { kind: 'dead' };
  switch (me.role) {
    case 'vampire':
      return { kind: 'bite' };
    case 'seer':
      return { kind: 'inspect' };
    case 'doctor':
      return { kind: 'protect', blockedId: me.resources.lastProtectedId ?? null };
    case 'hunter': {
      const bullets = me.resources.bullets ?? 0;
      if (view.round < HUNTER_FIRST_NIGHT) return { kind: 'hunter-waits' };
      return bullets > 0 ? { kind: 'shoot', bullets } : { kind: 'out-of-bullets' };
    }
    case 'survivor': {
      const shields = me.resources.shields ?? 0;
      return shields > 0 ? { kind: 'shield', shields } : { kind: 'out-of-shields' };
    }
    default:
      return { kind: 'sleep' };
  }
}

/** Who the viewer may pick tonight, in seat order (mirrors the reducer's checks). */
export function nightTargets(view: VillageView): VillagePlayer[] {
  const me = view.me;
  const task = nightTaskFor(view);
  const living = livingPlayers(view);
  switch (task.kind) {
    case 'bite': {
      const pack = new Set(me?.pack?.members ?? (me ? [me.id] : []));
      return living.filter((p) => !pack.has(p.id));
    }
    case 'inspect':
    case 'shoot':
      return living.filter((p) => p.id !== me?.id);
    case 'protect':
      return living.filter((p) => p.id !== task.blockedId);
    default:
      return [];
  }
}

export interface PackTally {
  /** Living vampires that must agree. */
  needed: number;
  /** Target → the vampires who picked it, in pack order. */
  byTarget: Record<string, string[]>;
  /** The target a majority agrees on, if any. */
  agreedId: string | null;
}

export function packTally(view: VillageView): PackTally {
  const pack = view.me?.pack;
  if (!pack) return { needed: 0, byTarget: {}, agreedId: null };
  const alive = new Set(livingPlayers(view).map((p) => p.id));
  const living = pack.members.filter((id) => alive.has(id));
  const needed = majorityNeeded(living.length);
  const byTarget: Record<string, string[]> = {};
  for (const id of living) {
    const target = pack.votes[id];
    if (!target || !alive.has(target)) continue;
    (byTarget[target] ??= []).push(id);
  }
  const agreed = Object.entries(byTarget).find(([, voters]) => voters.length >= needed);
  return { needed, byTarget, agreedId: agreed ? agreed[0] : null };
}

export interface VoteTally {
  /** Votes that hang someone: more than half of the living. */
  needed: number;
  living: number;
  /** Living players who have voted (for someone or for no one). */
  voted: number;
  /** One row per living player, in seat order — rows never jump while people click. */
  rows: Array<{ id: string; voters: string[] }>;
  /** Who voted to hang no one. */
  skip: string[];
  /** The single player with the most votes, if there is one. */
  leaderId: string | null;
}

export function voteTally(view: VillageView): VoteTally {
  const living = livingPlayers(view);
  const alive = new Set(living.map((p) => p.id));
  const rows = living.map((p) => ({ id: p.id, voters: [] as string[] }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skip: string[] = [];
  let voted = 0;
  for (const voter of living) {
    if (!Object.prototype.hasOwnProperty.call(view.votes, voter.id)) continue;
    const target = view.votes[voter.id];
    if (target === null) {
      skip.push(voter.id);
      voted += 1;
    } else if (target && alive.has(target)) {
      byId.get(target)?.voters.push(voter.id);
      voted += 1;
    }
  }
  const top = Math.max(0, ...rows.map((r) => r.voters.length));
  const leaders = rows.filter((r) => r.voters.length === top);
  return {
    needed: majorityNeeded(living.length),
    living: living.length,
    voted,
    rows,
    skip,
    leaderId: top > 0 && leaders.length === 1 ? leaders[0]!.id : null,
  };
}

/** The public events of the latest night, for the dawn announcement and the day's subtitle. */
export function lastNightNews(view: VillageView): VillageLogEntry[] {
  return view.log.filter(
    (e) =>
      e.round === view.round &&
      e.time === 'night' &&
      (e.kind === 'death' || e.kind === 'quiet-night' || e.kind === 'attack-stopped')
  );
}

export function todaysVerdict(view: VillageView): Extract<VillageLogEntry, { kind: 'vote-result' }> | null {
  for (let i = view.log.length - 1; i >= 0; i -= 1) {
    const entry = view.log[i]!;
    if (entry.kind === 'vote-result' && entry.round === view.round) return entry;
  }
  return null;
}

/** May the viewer write in the public game chat right now? */
export function canChat(view: VillageView): boolean {
  if (!view.me) return false;
  if (view.phase === 'ended') return true;
  return view.me.alive && PUBLIC_CHAT_PHASES.has(view.phase);
}

/** May the viewer whisper to the pack right now? */
export function canWhisper(view: VillageView): boolean {
  return (
    (view.phase === 'role_reveal' || view.phase === 'night') &&
    view.me?.role === 'vampire' &&
    view.me.alive &&
    view.me.pack !== null
  );
}

/** Public messages the viewer may still send this phase. */
export function chatLeft(view: VillageView): number {
  return view.me ? Math.max(0, CHAT_PER_PHASE - (view.chatSent[view.me.id] ?? 0)) : 0;
}

/** Whispers the viewer may still send this phase. */
export function whispersLeft(view: VillageView): number {
  const me = view.me;
  if (!me?.pack) return 0;
  const sent = me.pack.chat.filter((m) => m.authorId === me.id && m.phaseId === view.phaseId).length;
  return Math.max(0, PACK_CHAT_PER_PHASE - sent);
}

/** Null when the host may start; otherwise what is missing. */
export function startBlockers(view: VillageView): { needPlayers: number; waitingFor: string[] } | null {
  const needPlayers = Math.max(0, MIN_PLAYERS - view.players.length);
  const waitingFor = view.players.filter((p) => !p.ready).map((p) => p.id);
  return needPlayers === 0 && waitingFor.length === 0 ? null : { needPlayers, waitingFor };
}

/**
 * How long after a deadline this client reports the timeout. The host
 * goes first; every seat waits a little longer than the one before, and
 * spectators come last — so one client normally reports it, yet the game
 * never stalls because the host closed their tab.
 */
export function timeoutDelayMs(view: VillageView, actorUserId: string, hostUserId: string | null): number {
  if (hostUserId !== null && actorUserId === hostUserId) return 400;
  const seat = view.players.findIndex((p) => p.id === actorUserId);
  return seat >= 0 ? 2_500 + seat * 900 : 15_000;
}

