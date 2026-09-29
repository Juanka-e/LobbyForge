/**
 * Translation keys picked by value (role, cause, phase…). Spelled out in
 * full — never built with a template — so the locales test can see every
 * key the panel renders.
 */
import type {
  VillageColor,
  VillageDeathCause,
  VillageEndReason,
  VillagePhase,
  VillageRole,
  VillageTeam,
} from '../state';

export const ROLE_NAME: Record<VillageRole, string> = {
  vampire: 'vampire.role.vampire.name',
  villager: 'vampire.role.villager.name',
  seer: 'vampire.role.seer.name',
  doctor: 'vampire.role.doctor.name',
  hunter: 'vampire.role.hunter.name',
  survivor: 'vampire.role.survivor.name',
  jester: 'vampire.role.jester.name',
};

export const ROLE_BLURB: Record<VillageRole, string> = {
  vampire: 'vampire.role.vampire.blurb',
  villager: 'vampire.role.villager.blurb',
  seer: 'vampire.role.seer.blurb',
  doctor: 'vampire.role.doctor.blurb',
  hunter: 'vampire.role.hunter.blurb',
  survivor: 'vampire.role.survivor.blurb',
  jester: 'vampire.role.jester.blurb',
};

export const TEAM_NAME: Record<VillageTeam, string> = {
  vampires: 'vampire.team.vampires',
  village: 'vampire.team.village',
  neutral: 'vampire.team.neutral',
};

/** The goal line on the role card: by team, except the two loners. */
export function goalKey(role: VillageRole, team: VillageTeam): string {
  if (role === 'survivor') return 'vampire.goal.survivor';
  if (role === 'jester') return 'vampire.goal.jester';
  return team === 'vampires' ? 'vampire.goal.vampires' : 'vampire.goal.village';
}

/** Short tag on a dead player's card. */
export const CAUSE_TAG: Record<VillageDeathCause, string> = {
  bitten: 'vampire.cause.bitten',
  shot: 'vampire.cause.shot',
  remorse: 'vampire.cause.remorse',
  hanged: 'vampire.cause.hanged',
  fled: 'vampire.cause.fled',
  removed: 'vampire.cause.removed',
};

/** A sentence for the news and the log. */
export const CAUSE_NEWS: Record<VillageDeathCause, string> = {
  bitten: 'vampire.news.bitten',
  shot: 'vampire.news.shot',
  remorse: 'vampire.news.remorse',
  hanged: 'vampire.news.hanged',
  fled: 'vampire.news.fled',
  removed: 'vampire.news.removed',
};

export const COLOR_NAME: Record<VillageColor, string> = {
  rose: 'vampire.lobby.color.rose',
  amber: 'vampire.lobby.color.amber',
  ice: 'vampire.lobby.color.ice',
  mint: 'vampire.lobby.color.mint',
  violet: 'vampire.lobby.color.violet',
  coral: 'vampire.lobby.color.coral',
  sky: 'vampire.lobby.color.sky',
  sand: 'vampire.lobby.color.sand',
};

export const PHASE_PILL: Record<VillagePhase, string> = {
  lobby: 'vampire.pill.lobby',
  role_reveal: 'vampire.pill.reveal',
  night: 'vampire.pill.night',
  dawn: 'vampire.pill.dawn',
  day: 'vampire.pill.day',
  voting: 'vampire.pill.voting',
  verdict: 'vampire.pill.verdict',
  ended: 'vampire.pill.ended',
};

export const PHASE_TITLE: Record<VillagePhase, string> = {
  lobby: 'vampire.title',
  role_reveal: 'vampire.header.reveal',
  night: 'vampire.header.night',
  dawn: 'vampire.header.dawn',
  day: 'vampire.header.day',
  voting: 'vampire.header.voting',
  verdict: 'vampire.header.verdict',
  ended: 'vampire.header.ended',
};

/** The host's "next" button, named for what it does in each phase. */
export const NEXT_PHASE: Partial<Record<VillagePhase, string>> = {
  role_reveal: 'vampire.host.next.reveal',
  night: 'vampire.host.next.night',
  dawn: 'vampire.host.next.dawn',
  day: 'vampire.host.next.day',
  voting: 'vampire.host.next.voting',
  verdict: 'vampire.host.next.verdict',
};

export const END_REASON: Record<VillageEndReason, string> = {
  'vampires-gone': 'vampire.end.reason.vampires-gone',
  'vampires-parity': 'vampire.end.reason.vampires-parity',
  'no-team-left': 'vampire.end.reason.no-team-left',
  'host-ended': 'vampire.end.reason.host-ended',
};
