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
 */
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

/**
 * Returns true when this caller is the FIRST to claim the action id for
 * the session (i.e. the dispatch may proceed). False means a duplicate.
 */
export async function claimActionId(sessionId: string, actionId: string): Promise<boolean> {
  const result = await redis.set(claimKey(sessionId, actionId), '1', 'EX', CLAIM_TTL_SECONDS, 'NX');
  return result === 'OK';
}

/**
 * Release a claim after a failed dispatch so the client can retry the
 * same actionId. Best-effort: a stuck claim self-expires via TTL.
 */
export async function releaseActionId(sessionId: string, actionId: string): Promise<void> {
  try {
    await redis.del(claimKey(sessionId, actionId));
  } catch {
    // Swallow — the TTL is the backstop.
  }
}
