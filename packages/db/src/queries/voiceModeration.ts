import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { memberships } from '../schema.js';
import { recordMemberSanction } from './memberSanctions.js';

/**
 * Persistent MUTE_MEMBERS server mute. Returns false when the user is not
 * a member (nothing to update).
 */
export async function setMemberVoiceMuted(
  db: DbClient,
  serverId: string,
  userId: string,
  muted: boolean
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(memberships)
      .set({ voiceMuted: muted })
      .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
      .returning({ timedOutUntil: memberships.timedOutUntil, voiceMuted: memberships.voiceMuted });
    if (!row) return false;
    // security-review AUTHZ-002: the mute is mirrored outside the
    // membership row so leaving and rejoining cannot lift it.
    await recordMemberSanction(tx as unknown as DbClient, {
      serverId,
      userId,
      timedOutUntil: row.timedOutUntil,
      voiceMuted: row.voiceMuted,
    });
    return true;
  });
}

/** True when a moderator has server-muted this member. */
export async function isMemberVoiceMuted(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ voiceMuted: memberships.voiceMuted })
    .from(memberships)
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
    .limit(1);
  return row?.voiceMuted ?? false;
}
