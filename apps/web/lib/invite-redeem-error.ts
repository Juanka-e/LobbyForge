/**
 * What to tell a visitor whose invite could not be redeemed — in words,
 * never the status code or the server's developer text ("redeem → 500
 * Failed to redeem invite" used to reach the page as-is).
 *
 * The redeem route names some refusals with a `code`; where it does not,
 * the HTTP status says enough, except for a bare 403. That is "you are
 * banned" (the route's refusal says so, and the ban is checked before
 * anything about the invite), "the invite is unavailable" (expired, used
 * up or gone — the invite's public metadata tells which, so the page
 * re-reads it and asks `failureFromInvite`), or a refusal from in front of
 * the route, such as the origin guard, which only gets the generic
 * message. A ban is never inferred from a still-usable invite.
 */

export type RedeemFailure =
  | 'sessionExpired'
  | 'alreadyMember'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'banned'
  | 'requestLimit'
  | 'rateLimited'
  | 'generic';

/** The catalogue key for each failure. */
export const REDEEM_FAILURE_KEYS: Record<RedeemFailure, string> = {
  sessionExpired: 'auth.join.sessionExpired',
  alreadyMember: 'auth.join.alreadyMember',
  revoked: 'auth.join.revoked',
  expired: 'auth.join.error.expired',
  exhausted: 'auth.join.error.exhausted',
  banned: 'auth.join.error.banned',
  requestLimit: 'auth.join.requestLimit',
  rateLimited: 'auth.join.error.rateLimited',
  generic: 'auth.join.error.generic',
};

/**
 * Machine codes the route sends, or may send: today only
 * `join_request_limit`; the others are the reasons `redeemInvite` already
 * distinguishes, with and without an `invite_` prefix.
 */
const CODE_FAILURES: Record<string, RedeemFailure> = {
  expired: 'expired',
  invite_expired: 'expired',
  exhausted: 'exhausted',
  invite_exhausted: 'exhausted',
  not_found: 'revoked',
  invite_not_found: 'revoked',
  revoked: 'revoked',
  invite_revoked: 'revoked',
  banned: 'banned',
  already_member: 'alreadyMember',
  join_request_limit: 'requestLimit',
  rate_limited: 'rateLimited',
};

/**
 * The failure a refused redeem stands for, or `'checkInvite'` when only
 * the invite's current state can say (a 403 or 410 with no code).
 * `serverError` is the route's own `error` text: read for the word
 * "banned" on a bare 403, never shown. `join_rejected` and a 202 are not
 * failures; the page handles them first.
 */
export function classifyRedeemFailure(
  status: number,
  code?: unknown,
  serverError?: unknown
): RedeemFailure | 'checkInvite' {
  if (typeof code === 'string' && Object.hasOwn(CODE_FAILURES, code)) return CODE_FAILURES[code]!;
  if (status === 403 && typeof serverError === 'string' && /\bbanned\b/i.test(serverError)) return 'banned';
  switch (status) {
    case 401:
      return 'sessionExpired';
    case 403:
    case 410:
      return 'checkInvite';
    case 404:
      return 'revoked';
    case 409:
      return 'alreadyMember';
    case 429:
      return 'rateLimited';
    default:
      return 'generic';
  }
}

/**
 * Settles a `'checkInvite'` from the invite's metadata, re-read after the
 * refusal: `null` when the invite no longer exists. A still-usable invite
 * leaves the refusal unexplained, so it gets the generic message.
 */
export function failureFromInvite(invite: { isExpired: boolean; isExhausted: boolean } | null): RedeemFailure {
  if (!invite) return 'revoked';
  if (invite.isExpired) return 'expired';
  if (invite.isExhausted) return 'exhausted';
  return 'generic';
}
