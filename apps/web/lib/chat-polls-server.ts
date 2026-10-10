/**
 * Polls in text channels (docs/CHAT_POLLS.md) — the server half: session,
 * the poll-in-this-channel lookup and the batched per-viewer projection the
 * message list and the lobby's first render use. The rules themselves are
 * in `lib/chat-polls.ts`.
 */
import { NextResponse } from 'next/server';
import {
  getMessagePollById,
  getMessagePollWithTally,
  listMessagePollsForMessages,
  type MessagePollRow,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { readMessageBot } from '@/lib/bots/message-meta';
import { projectChatPoll, readMessagePollId, toChatPollUpdate, type ChatPollUpdate, type ChatPollView } from '@/lib/chat-polls';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

/** The signed-in member behind a request, or the 401/503 the messages routes answer. */
export function resolvePollSession(req: Request):
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse } {
  const session = readGuestSession(req.headers.get('cookie'), getSessionSecret());
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

/** The poll, when it exists, its message is not deleted, and it lives in this channel; else a 404. */
export async function loadChannelPoll(
  pollId: string,
  channelId: string
): Promise<{ ok: true; poll: MessagePollRow } | { ok: false; response: NextResponse }> {
  const poll = await getMessagePollById(getDb(), pollId);
  if (!poll || poll.channelId !== channelId) {
    return { ok: false, response: NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 }) };
  }
  return { ok: true, poll };
}

/** The poll as this viewer sees it, plus the public update to broadcast; null when it is gone. */
export async function loadPollForViewer(
  pollId: string,
  viewerUserId: string,
  now: Date = new Date()
): Promise<{ view: ChatPollView; update: ChatPollUpdate } | null> {
  const poll = await getMessagePollWithTally(getDb(), pollId, viewerUserId);
  if (!poll) return null;
  return { view: projectChatPoll(poll, now), update: toChatPollUpdate(poll, now) };
}

/**
 * The polls of a page of messages, projected for the viewer, keyed by
 * message id — ONE query for the whole page. Messages without
 * `metadata.poll` cost nothing.
 */
export async function loadPollViewsForMessages(
  rows: ReadonlyArray<Pick<MessageRow, 'id' | 'metadata'>>,
  viewerUserId: string | null,
  now: Date = new Date()
): Promise<Map<string, ChatPollView>> {
  const ids = rows.filter((row) => readMessagePollId(row.metadata) !== null).map((row) => row.id);
  const out = new Map<string, ChatPollView>();
  if (ids.length === 0) return out;
  const polls = await listMessagePollsForMessages(getDb(), ids, viewerUserId);
  for (const [messageId, poll] of polls) out.set(messageId, projectChatPoll(poll, now));
  return out;
}

/** A message row as the messages API returns it. */
export function messageJson(message: MessageRow): Record<string, unknown> {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    botId: message.botId ?? null,
    bot: readMessageBot(message),
    content: message.content,
    metadata: message.metadata,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}
