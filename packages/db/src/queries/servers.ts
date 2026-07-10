/**
 * Server queries — thin wrappers over the Drizzle client.
 *
 * "Server" in LobbyForge means a Discord-like guild: a top-level container
 * that holds channels, members, and roles. The schema is defined in
 * `../schema.ts` (see the `servers` table).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { memberships, servers } from '../schema.js';
import { seedDefaultRoles } from './roles.js';
import { createChannel } from './channels.js';

export interface ServerRow {
  id: string;
  name: string;
  slug: string | null;
  ownerUserId: string;
  iconUrl: string | null;
  defaultLocale: string;
  isPublic: boolean;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface CreateServerInput {
  name: string;
  slug?: string | null;
  ownerUserId: string;
  defaultLocale?: string;
  isPublic?: boolean;
}

/**
 * Create a server and auto-add the owner as a member. The membership row
 * is created in the same call so the owner can immediately see the server
 * in their list (without a second round-trip from the client). The
 * `seedDefaultRoles` call also assigns `@admin` to the owner so the
 * permission system has a starting state.
 */
export async function createServer(db: DbClient, input: CreateServerInput): Promise<ServerRow> {
  const [server] = await db
    .insert(servers)
    .values({
      name: input.name,
      slug: input.slug ?? null,
      ownerUserId: input.ownerUserId,
      defaultLocale: input.defaultLocale ?? 'en',
      isPublic: input.isPublic ?? false,
    })
    .returning();
  if (!server) {
    throw new Error('createServer: insert returned no rows');
  }
  await db.insert(memberships).values({
    serverId: server.id,
    userId: input.ownerUserId,
  });
  // Seed @everyone + @admin and assign @admin to the owner. The helper
  // is idempotent and joins on the owner's membership row, so it can be
  // safely called as part of the createServer flow.
  await seedDefaultRoles(db, server.id, input.ownerUserId);
  // Seed default channels so the server is immediately usable: one
  // text channel for general chat and one voice channel for hangouts.
  // Idempotent — if channels already exist (e.g. repair flow), these
  // are additive.
  try {
    await createChannel(db, { serverId: server.id, name: 'general', type: 'text', position: 0 });
    await createChannel(db, { serverId: server.id, name: 'Main Lounge', type: 'voice', position: 1 });
  } catch {
    // Channels may already exist if createServer is called as part of
    // a repair flow. Non-fatal — the server is still usable.
  }
  return server as ServerRow;
}

export async function getServerById(db: DbClient, id: string): Promise<ServerRow | null> {
  const found = await db
    .select()
    .from(servers)
    .where(and(eq(servers.id, id), isNull(servers.deletedAt)))
    .limit(1);
  return (found[0] as ServerRow | undefined) ?? null;
}

/**
 * List the servers a user is a member of, ordered by recency.
 * Soft-deleted servers are excluded. Limit defaults to 100 to keep the
 * initial response bounded; the UI can paginate later.
 */
export async function listServersForUser(
  db: DbClient,
  userId: string,
  options: { limit?: number } = {}
): Promise<ServerRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      slug: servers.slug,
      ownerUserId: servers.ownerUserId,
      iconUrl: servers.iconUrl,
      defaultLocale: servers.defaultLocale,
      isPublic: servers.isPublic,
      createdAt: servers.createdAt,
      deletedAt: servers.deletedAt,
    })
    .from(servers)
    .innerJoin(memberships, eq(memberships.serverId, servers.id))
    .where(and(eq(memberships.userId, userId), isNull(servers.deletedAt)))
    .orderBy(desc(servers.createdAt))
    .limit(limit);
  return rows as ServerRow[];
}

/**
 * Soft-delete a server. Only the owner should call this; the route layer
 * is responsible for the authorization check.
 */
export async function softDeleteServer(db: DbClient, id: string, now: Date = new Date()): Promise<void> {
  await db.update(servers).set({ deletedAt: now }).where(eq(servers.id, id));
}
