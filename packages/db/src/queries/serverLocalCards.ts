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
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverLocalCards } from '../schema.js';

export interface ServerLocalCardRow {
  id: string;
  serverId: string;
  pluginId: string;
  language: string | null;
  category: string | null;
  payload: Record<string, unknown>;
  difficulty: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface CreateServerLocalCardInput {
  serverId: string;
  pluginId: string;
  /** NEW-007: null = shared across all languages. */
  language?: string | null;
  category?: string | null;
  payload: Record<string, unknown>;
  difficulty?: string;
  createdBy?: string | null;
}

/**
 * List a server's local cards for a plugin.
 *
 * NEW-007: when `language` is provided the result is scoped to cards
 * tagged with that language PLUS language-less cards (NULL = common to
 * every deck). Without the filter, every local card is returned
 * (admin/tooling views).
 */
export async function listServerLocalCards(
  db: DbClient,
  serverId: string,
  pluginId?: string,
  language?: string
): Promise<ServerLocalCardRow[]> {
  const conditions = [eq(serverLocalCards.serverId, serverId)];
  if (pluginId) conditions.push(eq(serverLocalCards.pluginId, pluginId));
  if (language !== undefined) {
    conditions.push(or(isNull(serverLocalCards.language), eq(serverLocalCards.language, language))!);
  }
  const rows = await db
    .select()
    .from(serverLocalCards)
    .where(and(...conditions))
    .orderBy(asc(serverLocalCards.difficulty), asc(serverLocalCards.createdAt));
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
      language: input.language ?? null,
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
