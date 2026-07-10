/**
 * Hushle built-in pack seeder.
 *
 * Each plugin that ships built-in content should expose a `seedBuiltIn`
 * function. The host (web app) calls it on first boot and after
 * plugin version bumps. The seeder is idempotent — it skips any pack
 * whose `(pluginId, slug)` already exists in the `card_packs` table.
 *
 * The seeder does NOT touch the schema. The host runs migrations
 * first; the seeder just populates rows in the existing tables.
 */

import { seedBuiltInPacks, type CardPackRow, type DbClient } from '@lobbyforge/db';
import { HUSHLE_BUILTIN_PACKS } from './decks';
import { HUSHLE_PLUGIN_ID } from './plugin-id';

export { HUSHLE_PLUGIN_ID };

export interface SeedResult {
  pluginId: string;
  packs: Array<{ pack: CardPackRow; inserted: boolean }>;
}

export async function seedBuiltinHushlePacks(db: DbClient): Promise<SeedResult> {
  const packs = await seedBuiltInPacks(db, HUSHLE_PLUGIN_ID, HUSHLE_BUILTIN_PACKS);
  return { pluginId: HUSHLE_PLUGIN_ID, packs };
}
