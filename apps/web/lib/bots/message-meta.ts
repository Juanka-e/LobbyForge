/**
 * How a message says a bot wrote it — client-safe (no imports).
 *
 * The server writes `messages.bot_id` plus a `metadata.bot` snapshot
 * `{ id, name, type }`. The `bot` metadata key is reserved: the messages
 * API rejects it from clients (POST and PATCH), so only the Bot API and
 * the built-in bots can set it. The snapshot outlives the bot — after a
 * bot is deleted its messages still show its name and the BOT badge.
 */

export interface MessageBotInfo {
  id: string | null;
  /** '' when the snapshot has no name — the UI shows its own fallback. */
  name: string;
  type: string;
}

export function readMessageBot(
  message: { botId?: string | null; userId?: string | null; metadata?: unknown }
): MessageBotInfo | null {
  const metadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {};
  const raw = metadata.bot;
  const snapshot =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const botId = typeof message.botId === 'string' && message.botId ? message.botId : null;
  // A member message can never carry bot metadata (reserved key) — but a
  // row that has a user author is a member's message, whatever it holds.
  if (message.userId) return null;
  if (!botId && !snapshot) return null;
  const name = typeof snapshot?.name === 'string' ? snapshot.name.trim() : '';
  return {
    id: botId ?? (typeof snapshot?.id === 'string' ? snapshot.id : null),
    name,
    type: typeof snapshot?.type === 'string' ? snapshot.type : 'custom',
  };
}
