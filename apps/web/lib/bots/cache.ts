/**
 * A short-lived, per-process cache of each server's built-in bots.
 *
 * The Moderation Bot is consulted on EVERY message post, so its row must
 * not cost a query per message. Entries live 15 s (negative results too —
 * most servers never set up a bot) and every admin write through the bots
 * API invalidates its server at once in this process; other web workers
 * pick the change up when their entry expires.
 */
import { getBuiltInBotForServer, type BotRow, type BuiltInBotType } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

const TTL_MS = 15_000;
const MAX_ENTRIES = 2_000;

interface Entry {
  bot: BotRow | null;
  loadedAt: number;
}

const store = new Map<string, Entry>();

function keyOf(serverId: string, type: BuiltInBotType): string {
  return `${serverId}:${type}`;
}

export async function getBuiltInBot(serverId: string, type: BuiltInBotType): Promise<BotRow | null> {
  const key = keyOf(serverId, type);
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.loadedAt < TTL_MS) return hit.bot;
  const bot = await getBuiltInBotForServer(getDb(), serverId, type);
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { bot, loadedAt: now });
  return bot;
}

export function invalidateBotCache(serverId: string): void {
  store.delete(keyOf(serverId, 'welcome'));
  store.delete(keyOf(serverId, 'moderation'));
}

/** Test-only. */
export function __resetBotCache(): void {
  store.clear();
}
