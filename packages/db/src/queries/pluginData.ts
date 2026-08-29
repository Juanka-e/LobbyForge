/**
 * Plugin storage (Faz E) — the host-owned generic key-value store
 * behind the SDK's `ctx.storage`. Scoped by (serverId, pluginId, key);
 * plugins never touch SQL or a DbClient, the host reads/writes for
 * them, which is what makes community plugins safe.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { pluginData } from '../schema.js';

export interface PluginDataRow {
  id: string;
  serverId: string | null;
  pluginId: string;
  key: string;
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export class PluginKeyConstrainedError extends Error {
  constructor(key: string) {
    super(`Plugin storage key must be 1-128 chars of [a-zA-Z0-9._:-]: ${key}`);
    this.name = 'PluginKeyConstrainedError';
  }
}

const KEY_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new PluginKeyConstrainedError(key);
}

/** Fetch one value; undefined when the key does not exist. */
export async function getPluginData(
  db: DbClient,
  serverId: string,
  pluginId: string,
  key: string
): Promise<unknown> {
  assertKey(key);
  const [row] = await db
    .select({ value: pluginData.value })
    .from(pluginData)
    .where(
      and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId), eq(pluginData.key, key))
    )
    .limit(1);
  return row?.value ?? undefined;
}

/** Upsert one value (whole-value replace, like the card payloads). */
export async function setPluginData(
  db: DbClient,
  serverId: string,
  pluginId: string,
  key: string,
  value: unknown
): Promise<void> {
  assertKey(key);
  await db
    .insert(pluginData)
    .values({ serverId, pluginId, key, value: value as object })
    .onConflictDoUpdate({
      target: [pluginData.serverId, pluginData.pluginId, pluginData.key],
      set: { value: value as object, updatedAt: new Date() },
    });
}

/** Delete one key; returns whether a row was removed. */
export async function deletePluginData(
  db: DbClient,
  serverId: string,
  pluginId: string,
  key: string
): Promise<boolean> {
  assertKey(key);
  const rows = await db
    .delete(pluginData)
    .where(
      and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId), eq(pluginData.key, key))
    )
    .returning({ id: pluginData.id });
  return rows.length > 0;
}

/** Every key->value of a plugin on a server (bounded: a plugin's own scope). */
export async function listPluginData(
  db: DbClient,
  serverId: string,
  pluginId: string
): Promise<Array<{ key: string; value: unknown }>> {
  const rows = await db
    .select({ key: pluginData.key, value: pluginData.value })
    .from(pluginData)
    .where(and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId)));
  return rows;
}

/** Wipe a plugin's storage for a server (uninstall/cleanup path). */
export async function clearPluginData(db: DbClient, serverId: string, pluginId: string): Promise<void> {
  await db
    .delete(pluginData)
    .where(and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId)));
}

/** Rows of a server (diagnostics/uninstall preview). */
export async function listPluginDataForServer(
  db: DbClient,
  serverId: string
): Promise<PluginDataRow[]> {
  const rows = await db.select().from(pluginData).where(eq(pluginData.serverId, serverId));
  return rows as PluginDataRow[];
}
