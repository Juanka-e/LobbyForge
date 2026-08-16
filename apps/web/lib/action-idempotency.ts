/**
 * LF-002: exactly-once activity action dispatch.
 *
 * The CAS loop prevents LOST updates but not DUPLICATE application: a
 * client retrying a `correct-guess` (or the new Taboo `bust-forbidden`)
 * after a network timeout would otherwise score the same event twice.
 *
 * Contract: a client that wants exactly-once semantics attaches a
 * client-generated UUID `actionId` to the action body. The route claims
 * it (Redis SET NX + TTL) before touching the reducer; a second dispatch
 * with the same id is rejected as a duplicate. On any failure path the
 * claim is RELEASED so an honest retry isn't poisoned by a transient
 * error — the TTL is only a safety net, not the mechanism.
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
