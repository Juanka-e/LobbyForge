/**
 * Bot API v2 message metadata, read on the client — no server imports.
 *
 * - A bot's PUBLIC answer to a slash command carries
 *   `metadata.interaction = { id, commandName, invokedBy }` (BOT_API_V2 §3.4);
 *   the chat shows "↳ <user> used /<command>" above it.
 * - A post from an incoming channel webhook has `userId: null`, no bot, and
 *   `metadata.webhook = { id, name, username? }` (§5.1); it renders with the
 *   WEBHOOK badge.
 *
 * Both readers refuse what a member could forge: a message with a user
 * author is a member's message whatever its metadata says, an interaction
 * header only ever sits on a bot's message, and a webhook post is never a
 * bot's.
 */
import { readMessageBot } from './message-meta';

export interface MessageInteractionInfo {
  id: string;
  commandName: string;
  /** Whoever ran the command; `name` is null when only the id is known. */
  invokedBy: { id: string | null; name: string | null };
}

export interface MessageWebhookInfo {
  id: string | null;
  /** The webhook's own name. */
  name: string;
  /** What the chat shows: the post's `username` override, else the name ('' when neither). */
  displayName: string;
}

type MessageLike = { userId?: string | null; botId?: string | null; metadata?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readMessageInteraction(message: MessageLike): MessageInteractionInfo | null {
  if (message.userId) return null;
  if (!readMessageBot(message)) return null;
  const raw = record(record(message.metadata)?.interaction);
  if (!raw) return null;
  const id = text(raw.id);
  const commandName = text(raw.commandName);
  if (!id || !commandName) return null;
  let invokedBy: MessageInteractionInfo['invokedBy'] = { id: null, name: null };
  if (typeof raw.invokedBy === 'string') {
    invokedBy = { id: text(raw.invokedBy), name: null };
  } else {
    const who = record(raw.invokedBy);
    if (who) invokedBy = { id: text(who.id), name: text(who.displayName) ?? text(who.name) };
  }
  return { id, commandName, invokedBy };
}

export function readMessageWebhook(message: MessageLike): MessageWebhookInfo | null {
  if (message.userId) return null;
  if (typeof message.botId === 'string' && message.botId) return null;
  const metadata = record(message.metadata);
  if (record(metadata?.bot)) return null;
  const raw = record(metadata?.webhook);
  if (!raw) return null;
  const name = text(raw.name) ?? '';
  return { id: text(raw.id), name, displayName: text(raw.username) ?? name };
}
