/**
 * Server-local card queries.
 *
 * Custom card additions scoped to a single server. The reducer's deck
 * loader unions these with the global pack cards so a server owner
 * can add domain-specific words without forking the plugin's pack
 * (e.g. "Hushle — Turkish Server X Custom Words").
 *
 * M20a ships the table + CRUD + a difficulty-filtered list helper that
 * the reducer's weighted draw routine calls. The deck-loader side
 * (uniting global + local, applying the session's difficulty
 * distribution) lands in M20b alongside the admin UI.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverLocalCards } from '../schema.js';

export interface ServerLocalCardRow {
  id: string;
  serverId: string;
  pluginId: string;
  category: string | null;
  payload: Record<string, unknown>;
  difficulty: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface CreateServerLocalCardInput {
  serverId: string;
  pluginId: string;
  category?: string | null;
  payload: Record<string, unknown>;
  difficulty?: string;
  createdBy?: string | null;
}

export async function listServerLocalCards(
  db: DbClient,
  serverId: string,
  pluginId?: string
): Promise<ServerLocalCardRow[]> {
  const rows = pluginId
    ? await db
        .select()
        .from(serverLocalCards)
        .where(and(eq(serverLocalCards.serverId, serverId), eq(serverLocalCards.pluginId, pluginId)))
        .orderBy(asc(serverLocalCards.difficulty), asc(serverLocalCards.createdAt))
    : await db
        .select()
        .from(serverLocalCards)
        .where(eq(serverLocalCards.serverId, serverId))
        .orderBy(desc(serverLocalCards.createdAt));
  return rows as ServerLocalCardRow[];
}

export async function listServerLocalCardsByDifficulty(
  db: DbClient,
  serverId: string,
  pluginId: string,
  difficulty: string
): Promise<ServerLocalCardRow[]> {
  const rows = await db
    .select()
    .from(serverLocalCards)
    .where(
      and(
        eq(serverLocalCards.serverId, serverId),
        eq(serverLocalCards.pluginId, pluginId),
        eq(serverLocalCards.difficulty, difficulty)
      )
    )
    .orderBy(asc(serverLocalCards.createdAt));
  return rows as ServerLocalCardRow[];
}

export async function createServerLocalCard(
  db: DbClient,
  input: CreateServerLocalCardInput
): Promise<ServerLocalCardRow> {
  const [row] = await db
    .insert(serverLocalCards)
    .values({
      serverId: input.serverId,
      pluginId: input.pluginId,
      category: input.category ?? null,
      payload: input.payload,
      difficulty: input.difficulty ?? 'easy',
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('createServerLocalCard: insert returned no rows');
  return row as ServerLocalCardRow;
}

export async function deleteServerLocalCard(db: DbClient, id: string): Promise<boolean> {
  const rows = await db
    .delete(serverLocalCards)
    .where(eq(serverLocalCards.id, id))
    .returning({ id: serverLocalCards.id });
  return rows.length > 0;
}
