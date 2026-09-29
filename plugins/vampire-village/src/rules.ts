/**
 * Pure game rules shared by the reducer and the panel. No state, no React.
 */
import { MAX_PLAYERS, MIN_PLAYERS } from './state';
import type { VillageRole, VillageTeam } from './state';

/** Spec §9 fixed phase lengths. */
export const ROLE_REVEAL_SECONDS = 10;
export const DAWN_SECONDS = 5;
export const VERDICT_SECONDS = 5;

/** A client clock may run this far ahead of the server's before a timeout is refused. */
export const TIMEOUT_TOLERANCE_MS = 1_000;

export const HUNTER_BULLETS = 2;
export const SURVIVOR_SHIELDS = 3;
/** Spec §9: the first night is for information — the hunter shoots from night 2. */
export const HUNTER_FIRST_NIGHT = 2;

const TEAMS: Record<VillageRole, VillageTeam> = {
  vampire: 'vampires',
  villager: 'village',
  seer: 'village',
  doctor: 'village',
  hunter: 'village',
  survivor: 'neutral',
  jester: 'neutral',
};

export function teamOf(role: VillageRole): VillageTeam {
  return TEAMS[role];
}

/** Spec §8: vampires by player count. */
export function vampireCountFor(players: number): number {
  if (players >= 10) return 3;
  if (players >= 8) return 2;
  return 1;
}

/**
 * The roles dealt for `players` seats (spec §8), limited to the MVP set
 * (spec §23). Specials join in the spec's priority order; the Phase 2
 * roles the table counts on (witch, detective, arsonist, gossip, Eros,
 * mayor, fool) are replaced by plain villagers until they exist.
 *
 * Order matters only to tests (the reducer shuffles): vampires, seer,
 * doctor, survivor, hunter, jester, then villagers.
 */
export function rolesForPlayerCount(players: number): VillageRole[] {
  if (!Number.isInteger(players) || players < MIN_PLAYERS || players > MAX_PLAYERS) return [];
  const roles: VillageRole[] = [];
  for (let i = 0; i < vampireCountFor(players); i += 1) roles.push('vampire');
  roles.push('seer', 'doctor', 'survivor');
  if (players >= 6) roles.push('hunter');
  if (players >= 7) roles.push('jester');
  while (roles.length < players) roles.push('villager');
  return roles;
}

/** More than half of the living: the votes needed to hang someone. */
export function majorityNeeded(living: number): number {
  return Math.floor(Math.max(0, living) / 2) + 1;
}

/** Roles that must decide something before the night can end early. */
export const NIGHT_ROLES: ReadonlySet<VillageRole> = new Set(['vampire', 'seer', 'doctor', 'hunter', 'survivor']);
