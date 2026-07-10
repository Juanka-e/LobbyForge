export const CorePermission = {
  ADMINISTRATOR: 'administrator',
  MANAGE_SERVER: 'manage_server',
  MANAGE_CHANNELS: 'manage_channels',
  MANAGE_ROLES: 'manage_roles',
  KICK_MEMBERS: 'kick_members',
  BAN_MEMBERS: 'ban_members',
  CREATE_INVITE: 'create_invite',
  SEND_MESSAGES: 'send_messages',
  MANAGE_MESSAGES: 'manage_messages',
  ADD_REACTIONS: 'add_reactions',
  CONNECT_VOICE: 'connect_voice',
  SPEAK: 'speak',
  MUTE_MEMBERS: 'mute_members',
  DEAFEN_MEMBERS: 'deafen_members',
  VIEW_AUDIT_LOG: 'view_audit_log',
  START_ACTIVITY: 'start_activity',
} as const;

export type CorePermission = typeof CorePermission[keyof typeof CorePermission];

/**
 * Checks if a set of permissions allows a required permission, taking ADMINISTRATOR override into account.
 */
export function hasPermission(
  userPermissions: string[],
  requiredPermission: CorePermission
): boolean {
  if (userPermissions.includes(CorePermission.ADMINISTRATOR)) {
    return true;
  }
  return userPermissions.includes(requiredPermission);
}
