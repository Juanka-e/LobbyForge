/**
 * Human-readable labels for the action identifiers the API routes write
 * (`logAction(..., { action })`). The identifier itself is data; its
 * label is interface. An action missing here (a new route, a plugin)
 * still renders — callers fall back to the identifier itself.
 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  'activity.action': 'admin.audit.action.activity.action',
  'activity.create': 'admin.audit.action.activity.create',
  'activity.end': 'admin.audit.action.activity.end',
  'app.uninstall': 'admin.audit.action.app.uninstall',
  'app.upsert': 'admin.audit.action.app.upsert',
  'ban.create': 'admin.audit.action.ban.create',
  'ban.remove': 'admin.audit.action.ban.remove',
  'channel.create': 'admin.audit.action.channel.create',
  'channel.delete': 'admin.audit.action.channel.delete',
  'channel.update': 'admin.audit.action.channel.update',
  'invite.create': 'admin.audit.action.invite.create',
  'invite.redeem': 'admin.audit.action.invite.redeem',
  'invite.revoke': 'admin.audit.action.invite.revoke',
  'member.kick': 'admin.audit.action.member.kick',
  'member.leave': 'admin.audit.action.member.leave',
  'member.set_roles': 'admin.audit.action.member.set_roles',
  'member.timeout': 'admin.audit.action.member.timeout',
  'message.create': 'admin.audit.action.message.create',
  'message.delete': 'admin.audit.action.message.delete',
  'message.pin': 'admin.audit.action.message.pin',
  'message.unpin': 'admin.audit.action.message.unpin',
  'message.update': 'admin.audit.action.message.update',
  'role.create': 'admin.audit.action.role.create',
  'role.delete': 'admin.audit.action.role.delete',
  'role.update': 'admin.audit.action.role.update',
  'server.access_policy.update': 'admin.audit.action.server.access_policy.update',
  'server.banner.clear': 'admin.audit.action.server.banner.clear',
  'server.banner.update': 'admin.audit.action.server.banner.update',
  'voice.mute': 'admin.audit.action.voice.mute',
  'voice.unmute': 'admin.audit.action.voice.unmute',
};

/** The catalogue key for an audit action's label, or null for one we do not know. */
export function auditActionLabelKey(action: string): string | null {
  return ACTION_LABEL_KEYS[action] ?? null;
}
