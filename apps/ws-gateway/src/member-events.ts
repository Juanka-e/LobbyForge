/**
 * The `members:{serverId}` topic's payloads (docs/PROFILES.md "Live
 * updates"). Kept apart from server.ts so it can be tested without a socket.
 */
const MEMBER_EVENT_TYPES = new Set(['members-changed', 'members-removed', 'roles-changed']);
const MEMBER_EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most member ids one event names; a bigger change is sent as `roles-changed` (re-read everything). */
export const MEMBER_EVENT_MAX_IDS = 100;

export type MemberEvent =
  | { type: 'members-changed' | 'members-removed'; userIds: string[] }
  | { type: 'roles-changed' };

/**
 * docs/PROFILES.md "Live updates": the only shapes a `members:{serverId}`
 * subscriber receives. Like presence, an event is a "re-fetch" signal —
 * WHO changed, never what: the client re-reads those members over REST,
 * which projects their profiles for that viewer (privacy, blocks). Any
 * other field a publisher adds is dropped; an unknown type or a bad id
 * list drops the event (null).
 */
export function sanitizeMemberEvent(data: unknown): MemberEvent | null {
  if (!data || typeof data !== 'object') return null;
  const { type, userIds } = data as { type?: unknown; userIds?: unknown };
  if (typeof type !== 'string' || !MEMBER_EVENT_TYPES.has(type)) return null;
  if (type === 'roles-changed') return { type: 'roles-changed' };
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > MEMBER_EVENT_MAX_IDS) return null;
  if (!userIds.every((id) => typeof id === 'string' && MEMBER_EVENT_UUID.test(id))) return null;
  return { type: type as 'members-changed' | 'members-removed', userIds: [...new Set(userIds as string[])] };
}
