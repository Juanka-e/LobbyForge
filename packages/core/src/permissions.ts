export const CorePermission = {
  ADMINISTRATOR: 'administrator',
  MANAGE_SERVER: 'manage_server',
  MANAGE_CHANNELS: 'manage_channels',
  MANAGE_ROLES: 'manage_roles',
  KICK_MEMBERS: 'kick_members',
  BAN_MEMBERS: 'ban_members',
  CREATE_INVITE: 'create_invite',
  SEND_MESSAGES: 'send_messages',
  READ_MESSAGE_HISTORY: 'read_message_history',
  MENTION_EVERYONE: 'mention_everyone',
  MANAGE_MESSAGES: 'manage_messages',
  /** Reserved: the reactions feature is not built yet (no API route).
   *  Not shown in the roles UI until it ships — a visible no-op toggle
   *  misleads admins. */
  ADD_REACTIONS: 'add_reactions',
  CONNECT_VOICE: 'connect_voice',
  SPEAK: 'speak',
  /** Publish camera AND screen-share tracks. Server-wide toggles
   *  (allowCamera/allowScreenShare) AND this role permission must both
   *  allow — the LiveKit token route intersects them per member. */
  STREAM: 'stream',
  MUTE_MEMBERS: 'mute_members',
  /** Reserved: no deafen-others moderation endpoint yet (self-deafen is
   *  a local client preference, permission-free). Hidden from the UI. */
  DEAFEN_MEMBERS: 'deafen_members',
  /** Timeout members (mute from text AND voice) — the step between a
   *  warning and a kick/ban. Enforced on message send + mic publish. */
  MODERATE_MEMBERS: 'moderate_members',
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
