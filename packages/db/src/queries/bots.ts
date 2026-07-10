import { asc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { bots } from '../schema.js';

export interface BotRow {
  id: string;
  serverId: string;
  name: string;
  type: string;
  tokenHash: string | null;
  permissions: string[];
  enabled: boolean;
  createdAt: Date;
}

export async function listBotsForServer(
  db: DbClient,
  serverId: string
): Promise<BotRow[]> {
  const rows = await db
    .select({
      id: bots.id,
      serverId: bots.serverId,
      name: bots.name,
      type: bots.type,
      tokenHash: bots.tokenHash,
      permissions: bots.permissions,
      enabled: bots.enabled,
      createdAt: bots.createdAt,
    })
    .from(bots)
    .where(eq(bots.serverId, serverId))
    .orderBy(asc(bots.createdAt));
  return rows.map((row) => ({
    ...row,
    permissions: Array.isArray(row.permissions) ? (row.permissions as string[]) : [],
  }));
}
