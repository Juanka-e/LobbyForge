/**
 * What the profile card says when a route refuses one of its actions —
 * from the route's machine-readable `code` (lib/member-authorization.ts),
 * never its English `error`. Keys, not text: the card resolves them with
 * its own translator.
 */
import type { Params } from '@/lib/i18n/core';

export type ProfileAction = 'roles' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'mute' | 'message';

export interface ProfileActionRefusal {
  status: number;
  code?: unknown;
  /** The role route lists the permissions a role carries that the actor may not grant. */
  permissions?: unknown;
}

export function profileActionErrorMessage(action: ProfileAction, refusal: ProfileActionRefusal): { key: string; params?: Params } {
  const { status, code } = refusal;
  if (action === 'message') {
    if (status === 403 || status === 404) return { key: 'shell.profile.error.cannotMessage' };
    if (status === 429) return { key: 'shell.profile.error.rateLimited' };
    return { key: 'shell.profile.error.generic', params: { status } };
  }
  switch (code) {
    case 'actor_timed_out':
      return { key: 'shell.profile.error.timedOut' };
    case 'insufficient_rank':
      return { key: 'shell.profile.error.rank' };
    case 'target_is_owner':
      return { key: 'shell.profile.error.owner' };
    case 'self_action':
      return { key: 'shell.profile.error.self' };
    case 'target_not_member':
    case 'user_not_found':
      return { key: 'shell.profile.error.notMember' };
    case 'forbidden':
      return { key: 'shell.profile.error.forbidden' };
    default:
      break;
  }
  if (status === 429) return { key: 'shell.profile.error.rateLimited' };
  if (action === 'roles' && status === 403) {
    // The role route's own refusals: a role at or above the actor, or one
    // carrying a permission the actor may not grant.
    return Array.isArray(refusal.permissions)
      ? { key: 'shell.profile.error.roleGrant' }
      : { key: 'shell.profile.error.roleRank' };
  }
  if (action === 'ban' && status === 409) return { key: 'shell.profile.error.alreadyBanned' };
  if (status === 403) return { key: 'shell.profile.error.forbidden' };
  if (status === 404) return { key: 'shell.profile.error.notFound' };
  return { key: 'shell.profile.error.generic', params: { status } };
}
