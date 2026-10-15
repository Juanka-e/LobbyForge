/**
 * The name a member goes by in a community, resolved on the server: their
 * community nickname first, then their account's display name. Voice
 * (the LiveKit participant name) and the typing indicator use it, so a
 * member cannot appear under a name they chose for the request — and a
 * rename or a new nickname shows at once instead of the session cookie's
 * stale copy. `fallback` (the signed session's name) is only used when
 * the lookup fails or finds nothing.
 */
import { getServerMember, getUserById } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

const MAX_NAME_LENGTH = 64;

export async function resolveMemberDisplayName(serverId: string, userId: string, fallback: string): Promise<string> {
  try {
    const member = await getServerMember(getDb(), serverId, userId);
    if (member?.nickname) return member.nickname.slice(0, MAX_NAME_LENGTH);
    const user = await getUserById(getDb(), userId);
    if (user?.displayName) return user.displayName.slice(0, MAX_NAME_LENGTH);
  } catch {
    // Fall back to the signed session name.
  }
  return fallback;
}
