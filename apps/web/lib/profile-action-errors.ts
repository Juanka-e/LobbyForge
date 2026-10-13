/**
 * What the profile card — and the admin Members page — say when a route
 * refuses a moderation action: from the route's machine-readable `code`
 * (lib/member-authorization.ts, and the kick, ban, role and timeout routes'
 * own refusals before that gate), never its English `error`. Keys, not
 * text: each surface resolves them with its own translator.
 */
import type { Params } from '@/lib/i18n/core';

export type ProfileAction = 'roles' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'mute' | 'message';

export interface ProfileActionRefusal {
  status: number;
  code?: unknown;
  /** The role route lists the permissions a role carries that the actor may not grant. */
  permissions?: unknown;
}

/** The sentence for each refusal code the moderation routes send. */
const REFUSAL_CODE_KEYS: Readonly<Record<string, string>> = {
  // The moderation gate (lib/member-authorization.ts).
  actor_timed_out: 'shell.profile.error.timedOut',
  insufficient_rank: 'shell.profile.error.rank',
  target_is_owner: 'shell.profile.error.owner',
  self_action: 'shell.profile.error.self',
  target_not_member: 'shell.profile.error.notMember',
  user_not_found: 'shell.profile.error.notMember',
  forbidden: 'shell.profile.error.forbidden',
  invalid_request: 'shell.profile.error.invalidRequest',
  server_not_found: 'shell.profile.error.serverGone',
  // The routes' own refusals, before or after the gate.
  unauthenticated: 'shell.profile.error.signIn',
  session_not_materialized: 'shell.profile.error.signIn',
  already_banned: 'shell.profile.error.alreadyBanned',
  role_not_found: 'shell.profile.error.notFound',
  role_above_actor: 'shell.profile.error.roleRank',
  ungrantable_permissions: 'shell.profile.error.roleGrant',
};

/** Every code this module says in words (for tests and other surfaces). */
export const KNOWN_REFUSAL_CODES: readonly string[] = Object.keys(REFUSAL_CODE_KEYS);

/** The generic "That didn't work" answer — a surface may say its own instead. */
export const GENERIC_REFUSAL_KEY = 'shell.profile.error.generic';

export function profileActionErrorMessage(action: ProfileAction, refusal: ProfileActionRefusal): { key: string; params?: Params } {
  const { status, code } = refusal;
  if (action === 'message') {
    if (status === 403 || status === 404) return { key: 'shell.profile.error.cannotMessage' };
    if (status === 429) return { key: 'shell.profile.error.rateLimited' };
    return { key: GENERIC_REFUSAL_KEY, params: { status } };
  }
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_CODE_KEYS, code)) {
    return { key: REFUSAL_CODE_KEYS[code]! };
  }
  if (status === 429) return { key: 'shell.profile.error.rateLimited' };
  if (status === 401) return { key: 'shell.profile.error.signIn' };
  if (action === 'roles' && status === 403) {
    // A role route without a code (an older server): a role at or above
    // the actor, or one carrying a permission the actor may not grant.
    return Array.isArray(refusal.permissions)
      ? { key: 'shell.profile.error.roleGrant' }
      : { key: 'shell.profile.error.roleRank' };
  }
  if (action === 'ban' && status === 409) return { key: 'shell.profile.error.alreadyBanned' };
  if (status === 403) return { key: 'shell.profile.error.forbidden' };
  if (status === 404) return { key: 'shell.profile.error.notFound' };
  return { key: GENERIC_REFUSAL_KEY, params: { status } };
}
