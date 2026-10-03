export function liveKitRoomName(serverId: string, channelId: string): string {
  return `s_${serverId.replaceAll('-', '')}_c_${channelId.replaceAll('-', '')}`;
}

const ROOM_NAME_RE = /^s_([0-9a-f]{32})_c_([0-9a-f]{32})$/i;

function dashedUuid(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The inverse of `liveKitRoomName`: the server and channel a LiveKit room
 * belongs to, or null for a name this app did not mint.
 */
export function parseLiveKitRoomName(room: string): { serverId: string; channelId: string } | null {
  const match = ROOM_NAME_RE.exec(room);
  if (!match) return null;
  return { serverId: dashedUuid(match[1]!), channelId: dashedUuid(match[2]!) };
}
