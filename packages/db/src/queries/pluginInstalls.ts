import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { pluginsEnabled } from '../schema.js';

export interface PluginInstallRow {
  id: string;
  serverId: string;
  pluginId: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: Date;
}

export interface UpsertPluginInstallInput {
  serverId: string;
  pluginId: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export async function listPluginInstallsForServer(
  db: DbClient,
  serverId: string
): Promise<PluginInstallRow[]> {
  const rows = await db
    .select()
    .from(pluginsEnabled)
    .where(eq(pluginsEnabled.serverId, serverId))
    .orderBy(asc(pluginsEnabled.createdAt));
  return rows as PluginInstallRow[];
}

export async function getPluginInstall(
  db: DbClient,
  serverId: string,
  pluginId: string
): Promise<PluginInstallRow | null> {
  const [row] = await db
    .select()
    .from(pluginsEnabled)
    .where(and(eq(pluginsEnabled.serverId, serverId), eq(pluginsEnabled.pluginId, pluginId)))
    .limit(1);
  return (row as PluginInstallRow | undefined) ?? null;
}

export async function upsertPluginInstall(
  db: DbClient,
  input: UpsertPluginInstallInput
): Promise<PluginInstallRow> {
  const existing = await getPluginInstall(db, input.serverId, input.pluginId);
  if (existing) {
    const [row] = await db
      .update(pluginsEnabled)
      .set({
        enabled: input.enabled ?? existing.enabled,
        settings: input.settings ?? existing.settings,
      })
      .where(eq(pluginsEnabled.id, existing.id))
      .returning();
    if (!row) throw new Error('upsertPluginInstall: update returned no rows');
    return row as PluginInstallRow;
  }

  const [row] = await db
    .insert(pluginsEnabled)
    .values({
      serverId: input.serverId,
      pluginId: input.pluginId,
      enabled: input.enabled ?? true,
      settings: input.settings ?? {},
    })
    .returning();
  if (!row) throw new Error('upsertPluginInstall: insert returned no rows');
  return row as PluginInstallRow;
}

export async function deletePluginInstall(
  db: DbClient,
  serverId: string,
  pluginId: string
): Promise<boolean> {
  const rows = await db
    .delete(pluginsEnabled)
    .where(and(eq(pluginsEnabled.serverId, serverId), eq(pluginsEnabled.pluginId, pluginId)))
    .returning({ id: pluginsEnabled.id });
  return rows.length > 0;
}
