/**
 * LF-002: duplicate-suppression for activity action dispatches.
 *
 * CONTRACT (deliberately NOT "exactly-once"): within the TTL window the
 * same (sessionId, actionId) is admitted to the reducer at most ONCE.
 * There is no response replay — if the caller loses the response after
 * commit, a retry with the same id gets 409 {duplicate:true} and must
 * re-GET the activity state to reconcile (the UI does this).
 *
 * The CAS loop prevents LOST updates but not DUPLICATE application: a
 * client retrying a `correct-guess` (or the Taboo `bust-forbidden`)
 * after a network timeout would otherwise score the same event twice.
 *
 * A client that wants this protection attaches a client-generated UUID
 * `actionId` to the action body. The route claims it (Redis SET NX +
 * TTL) before touching the reducer; a second dispatch with the same id
 * is rejected as a duplicate. On any failure path the claim is RELEASED
 * so an honest retry works. If the claim store itself THROWS, the route
 * fails closed with a retryable 503 (V4-001) — never a fake duplicate.
 *
 * V5-007 release safety: each claim stores a random ownership token and
 * release is a Redis compare-and-delete — a stale owner (whose claim
 * expired and was re-claimed by another request) can no longer delete
 * the NEW claim out from under it.
 */
import { randomUUID } from 'node:crypto';
import { redis } from '@/lib/redis';

/** Long enough to outlive any mobile-network retry storm, short enough
 * that abandoned claims don't accumulate. */
const CLAIM_TTL_SECONDS = 600;

const ACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidActionId(value: unknown): value is string {
  return typeof value === 'string' && ACTION_ID_PATTERN.test(value);
}

function claimKey(sessionId: string, actionId: string): string {
  return `lf:action-dedup:${sessionId}:${actionId}`;
}

/** Ownership token returned by a successful claim; required to release. */
export interface ActionClaim {
  sessionId: string;
  actionId: string;
  token: string;
}

/**
 * Returns a claim handle when this caller is the FIRST to claim the
 * action id for the session (i.e. the dispatch may proceed). Throws on
 * store errors (the route maps that to a retryable 503 — V4-001).
 */
export async function claimActionId(sessionId: string, actionId: string): Promise<ActionClaim> {
  const token = randomUUID();
  const result = await redis.set(
    claimKey(sessionId, actionId),
    token,
    'EX',
    CLAIM_TTL_SECONDS,
    'NX'
  );
  if (result !== 'OK') {
    // Signal the duplicate without a claim handle.
    return Promise.reject(new DuplicateActionError());
  }
  return { sessionId, actionId, token };
}

/** Thrown by claimActionId when the id is already claimed. Distinct from
 * a store failure so the route can answer 409 vs 503 precisely. */
export class DuplicateActionError extends Error {
  constructor() {
    super('Duplicate action — already processed.');
    this.name = 'DuplicateActionError';
  }
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * Release a claim after a failed dispatch so the client can retry the
 * same actionId. Compare-and-delete: only the claim's current owner
 * token removes the key — a stale owner whose claim expired (and was
 * re-claimed) must not delete the new claim. Best-effort; the TTL is
 * the backstop.
 */
export async function releaseActionId(claim: ActionClaim): Promise<void> {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, claimKey(claim.sessionId, claim.actionId), claim.token);
  } catch {
    // Swallow — the TTL is the backstop.
  }
}
