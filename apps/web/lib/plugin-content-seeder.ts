/** First-use entry point for trusted official component data migrations. */
import type { DbClient } from '@lobbyforge/db';
import { ensureBuiltInContentSeeded as run } from '@/lib/component-migrations';

export function ensureBuiltInContentSeeded(_db: DbClient): Promise<void> {
  return run(_db);
}
