/**
 * Server member sanctions (0040) — security-review AUTHZ-002.
 *
 * A MODERATE_MEMBERS timeout and a MUTE_MEMBERS server mute used to live
 * ONLY on the `memberships` row. Leaving the server deletes that row and
 * every rejoin path (invite redeem, the /lobby auto-join) inserts a fresh
 * one, so a member could shed a 28-day timeout in seconds: create an
 * invite, leave, redeem it.
 *
 * The membership columns stay the read path (the token route, the message
 * gates and the live voice sync all read them); this table is the copy
 * that survives the membership:
 *   - every write of a timeout or a server mute mirrors the membership's
 *     moderation state here (`recordMemberSanction`), and
 *   - every path that creates a membership starts the new row from it
 *     (`membershipValuesFromSanction`).
 */
import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverMemberSanctions } from '../schema.js';

export interface MemberSanctionRow {
  serverId: string;
  userId: string;
  timedOutUntil: Date | null;
  voiceMuted: boolean;
  updatedAt: Date;
}

/** The stored moderation state for (server, user), or null when there is none. */
export async function getMemberSanction(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<MemberSanctionRow | null> {
  const [row] = await db
    .select()
    .from(serverMemberSanctions)
    .where(and(eq(serverMemberSanctions.serverId, serverId), eq(serverMemberSanctions.userId, userId)))
    .limit(1);
  return (row as MemberSanctionRow | undefined) ?? null;
}

/**
 * Store the member's CURRENT moderation state (both fields — callers pass
 * what the membership row now holds, so the two copies cannot drift). A
 * cleared state is stored too rather than deleted: it is one small row and
 * keeps the write path a single upsert.
 */
export async function recordMemberSanction(
  db: DbClient,
  input: { serverId: string; userId: string; timedOutUntil: Date | null; voiceMuted: boolean }
): Promise<void> {
  const now = new Date();
  await db
    .insert(serverMemberSanctions)
    .values({
      serverId: input.serverId,
      userId: input.userId,
      timedOutUntil: input.timedOutUntil,
      voiceMuted: input.voiceMuted,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [serverMemberSanctions.serverId, serverMemberSanctions.userId],
      set: { timedOutUntil: input.timedOutUntil, voiceMuted: input.voiceMuted, updatedAt: now },
    });
}

/**
 * The membership column values a NEW membership row must start with, so a
 * rejoin keeps the timeout / server mute in force. Empty when there is no
 * stored state (the column defaults apply).
 */
export function membershipValuesFromSanction(
  sanction: Pick<MemberSanctionRow, 'timedOutUntil' | 'voiceMuted'> | null
): { timedOutUntil?: Date | null; voiceMuted?: boolean } {
  if (!sanction) return {};
  return { timedOutUntil: sanction.timedOutUntil, voiceMuted: sanction.voiceMuted };
}
