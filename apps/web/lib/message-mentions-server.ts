/**
 * Server half of chat mentions (docs/PROFILES.md "Mentions"): which members
 * a message names, worked out from the composer's picks and the handles
 * typed in the text — never trusted from the client as-is.
 */
import { NextResponse } from 'next/server';
import { findMembersByUsernames, listMemberSummariesForServer } from '@lobbyforge/db';
import type { DbClient } from '@lobbyforge/db';
import { contentMentions, findHandleMentions, MAX_MENTIONS, type StoredMention } from '@/lib/mentions';

/**
 * The mentions to store with `content` in `serverId`:
 *
 *   - each requested id that is a current member AND whose community name,
 *     account name or handle stands as `@…` in the text (the picker inserts
 *     the name; a pick whose name was deleted again is dropped);
 *   - each `@handle` in the text that belongs to a current member.
 *
 * Someone who is not a member, or a name that is not in the text, names
 * nobody. At most `MAX_MENTIONS`, in the order found.
 */
export async function resolveMessageMentions(
  db: DbClient,
  serverId: string,
  content: string,
  requestedIds: readonly string[] = []
): Promise<StoredMention[]> {
  const out: StoredMention[] = [];
  const seen = new Set<string>();
  const ids = [...new Set(requestedIds)].slice(0, MAX_MENTIONS);
  if (ids.length > 0) {
    const members = await listMemberSummariesForServer(db, serverId, { userIds: ids });
    const byId = new Map(members.map((member) => [member.userId, member]));
    for (const id of ids) {
      const member = byId.get(id);
      if (!member) continue;
      // The longest label first: "@Ada Lovelace" is that, not "@Ada".
      const labels = [member.nickname, member.globalDisplayName, member.username]
        .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
        .sort((a, b) => b.length - a.length);
      const label = labels.find((candidate) => contentMentions(content, candidate));
      if (!label) continue;
      out.push({ userId: id, text: label });
      seen.add(id);
    }
  }
  const handles = findHandleMentions(content);
  if (handles.length > 0 && out.length < MAX_MENTIONS) {
    const matches = await findMembersByUsernames(db, serverId, handles);
    const byHandle = new Map(matches.map((row) => [row.username, row.userId]));
    for (const handle of handles) {
      const userId = byHandle.get(handle);
      if (!userId || seen.has(userId)) continue;
      out.push({ userId, text: handle });
      seen.add(userId);
      if (out.length >= MAX_MENTIONS) break;
    }
  }
  return out.slice(0, MAX_MENTIONS);
}

/**
 * A refused `@everyone` / `@here`, with a code the composer translates
 * (the permission helper's body is a bare English "Forbidden"). Anything
 * but a 403 (no session, no server) passes through unchanged.
 */
export function mentionEveryoneRefusal(response: NextResponse): NextResponse {
  if (response.status !== 403) return response;
  return NextResponse.json(
    { error: 'You cannot mention @everyone or @here here', code: 'mention_everyone_forbidden' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}
