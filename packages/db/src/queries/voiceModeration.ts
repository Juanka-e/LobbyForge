import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { memberships } from '../schema.js';

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
  const rows = await db
    .update(memberships)
    .set({ voiceMuted: muted })
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
    .returning({ id: memberships.id });
  return rows.length > 0;
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
