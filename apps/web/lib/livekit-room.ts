export function liveKitRoomName(serverId: string, channelId: string): string {
  return `s_${serverId.replaceAll('-', '')}_c_${channelId.replaceAll('-', '')}`;
}
