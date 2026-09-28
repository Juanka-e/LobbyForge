/**
 * Who explains next — Hushle's explainer rotation.
 *
 * Teams take turns in seat order. Each team has its OWN rotation: its
 * players in seat order, and each time the team plays, the next player in
 * it explains. With two teams of two, four turns give all four players one
 * turn each.
 *
 * An odd player count leaves one player as the floater. The floater has a
 * slot in EVERY team's rotation, so across a full round they explain once
 * for each team while everyone else explains once. Their slot is staggered
 * from team to team — after the first player in the first team's rotation,
 * half a round later in the next — so their turns fall apart instead of
 * back to back. A team with no players of its own is explained for by the
 * floater every time.
 *
 * Pure functions over the state: the reducer, the state migration and the
 * panel ("next up") all use these, so they cannot disagree.
 */

import type { HushleState } from './state';

type RotationState = Pick<HushleState, 'teams' | 'floaterPlayerId'>;

/** The explainer rotation of the team at `teamIndex`, in the order its turns go. */
export function explainerQueue(state: RotationState, teamIndex: number): string[] {
  const team = state.teams[teamIndex];
  if (!team) return [];
  const floater = state.floaterPlayerId;
  if (!floater) return [...team.playerIds];
  const members = team.playerIds.filter((id) => id !== floater);
  const teamCount = Math.max(1, state.teams.length);
  // First team: after its first player. Each later team: a proportional
  // step further round its rotation, never past the end.
  const slot = Math.min(members.length, 1 + Math.floor((teamIndex * (members.length + 1)) / teamCount));
  return [...members.slice(0, slot), floater, ...members.slice(slot)];
}

/** The player the team's next turn goes to, and that player's slot in its rotation. */
export function nextExplainer(state: RotationState, teamIndex: number): { explainerId: string | null; slot: number } {
  const queue = explainerQueue(state, teamIndex);
  if (queue.length === 0) return { explainerId: null, slot: -1 };
  const cursor = Math.floor(state.teams[teamIndex]?.nextExplainerSlot ?? 0);
  const slot = ((cursor % queue.length) + queue.length) % queue.length;
  return { explainerId: queue[slot] ?? null, slot };
}

/**
 * The rotation cursor after `explainerId` explains for the team: the slot
 * right after theirs. Unchanged when they are not in the team's rotation
 * (someone the host picked from elsewhere).
 */
export function cursorAfter(state: RotationState, teamIndex: number, explainerId: string | null): number | null {
  if (!explainerId) return null;
  const queue = explainerQueue(state, teamIndex);
  const slot = queue.indexOf(explainerId);
  return slot === -1 ? null : (slot + 1) % queue.length;
}
