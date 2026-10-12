/**
 * Plugin storage (Faz E) — the host-owned generic key-value store
 * behind the SDK's `ctx.storage`. Scoped by (serverId, pluginId, key);
 * plugins never touch SQL or a DbClient, the host reads/writes for
 * them, which is what makes community plugins safe.
 */
import { and, eq, sql } from 'drizzle-orm';
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

/** One write of a batch: a key's new value, or its removal. */
export type PluginDataWrite = { key: string; value: unknown } | { key: string; delete: true };

/** The batch would take the plugin's storage on this server past its limit; nothing was written. */
export class PluginStorageFullError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`Plugin storage would hold ${bytes} bytes (limit ${maxBytes}); nothing was written`);
    this.name = 'PluginStorageFullError';
  }
}

/** Advisory-lock key of one plugin's storage on one server (`hashtext` of it). */
export function pluginDataLockKey(serverId: string, pluginId: string): string {
  return `lobbyforge:plugin-data:${serverId}:${pluginId}`;
}

/**
 * Apply a batch of writes to one plugin's storage on one server — the
 * `storage.set` / `storage.delete` effects of one reducer call
 * (docs/PLUGIN_SDK.md "Effects"). All or nothing, in one transaction that
 * holds a transaction-scoped advisory lock on (server, plugin), so two
 * sessions of the same plugin writing at once cannot both slip under the
 * limit: the batch is measured (`sizeOf`, the SDK's `storageBytes`) on the
 * storage as it stands under the lock, and refused with
 * `PluginStorageFullError` when the result would exceed `maxBytes`.
 */
export async function writePluginDataBatch(
  db: DbClient,
  serverId: string,
  pluginId: string,
  writes: readonly PluginDataWrite[],
  limit: { maxBytes: number; sizeOf: (entries: Record<string, unknown>) => number }
): Promise<void> {
  for (const write of writes) assertKey(write.key);
  if (writes.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pluginDataLockKey(serverId, pluginId)}))`);
    const rows = await tx
      .select({ key: pluginData.key, value: pluginData.value })
      .from(pluginData)
      .where(and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId)));
    // Null prototype: a key is only ever an own property.
    const entries = Object.create(null) as Record<string, unknown>;
    for (const row of rows) entries[row.key] = row.value;
    for (const write of writes) {
      if ('delete' in write) delete entries[write.key];
      else entries[write.key] = write.value;
    }
    const bytes = limit.sizeOf(entries);
    if (bytes > limit.maxBytes) throw new PluginStorageFullError(bytes, limit.maxBytes);
    const now = new Date();
    for (const write of writes) {
      if ('delete' in write) {
        await tx
          .delete(pluginData)
          .where(and(eq(pluginData.serverId, serverId), eq(pluginData.pluginId, pluginId), eq(pluginData.key, write.key)));
      } else {
        await tx
          .insert(pluginData)
          .values({ serverId, pluginId, key: write.key, value: write.value as object })
          .onConflictDoUpdate({
            target: [pluginData.serverId, pluginData.pluginId, pluginData.key],
            set: { value: write.value as object, updatedAt: now },
          });
      }
    }
  });
}

/** Rows of a server (diagnostics/uninstall preview). */
export async function listPluginDataForServer(
  db: DbClient,
  serverId: string
): Promise<PluginDataRow[]> {
  const rows = await db.select().from(pluginData).where(eq(pluginData.serverId, serverId));
  return rows as PluginDataRow[];
}
