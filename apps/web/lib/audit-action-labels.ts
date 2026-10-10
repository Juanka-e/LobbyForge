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
  'activity.host_transfer': 'admin.audit.action.activity.host_transfer',
  'app.uninstall': 'admin.audit.action.app.uninstall',
  'app.upsert': 'admin.audit.action.app.upsert',
  'bot.create': 'admin.audit.action.bot.create',
  'bot.delete': 'admin.audit.action.bot.delete',
  'bot.disable': 'admin.audit.action.bot.disable',
  'bot.enable': 'admin.audit.action.bot.enable',
  'bot.moderation.block': 'admin.audit.action.bot.moderation.block',
  'bot.token.issue': 'admin.audit.action.bot.token.issue',
  'bot.token.revoke': 'admin.audit.action.bot.token.revoke',
  'bot.token.rotate': 'admin.audit.action.bot.token.rotate',
  'bot.update': 'admin.audit.action.bot.update',
  'ban.create': 'admin.audit.action.ban.create',
  'ban.remove': 'admin.audit.action.ban.remove',
  'channel.create': 'admin.audit.action.channel.create',
  'channel.delete': 'admin.audit.action.channel.delete',
  'channel.update': 'admin.audit.action.channel.update',
  'instance.captcha_updated': 'admin.audit.action.instance.captcha_updated',
  'instance.mail_updated': 'admin.audit.action.instance.mail_updated',
  'invite.create': 'admin.audit.action.invite.create',
  'invite.redeem': 'admin.audit.action.invite.redeem',
  'invite.revoke': 'admin.audit.action.invite.revoke',
  'member.join_approved': 'admin.audit.action.member.join_approved',
  'member.join_rejected': 'admin.audit.action.member.join_rejected',
  'member.kick': 'admin.audit.action.member.kick',
  'member.leave': 'admin.audit.action.member.leave',
  'member.set_roles': 'admin.audit.action.member.set_roles',
  'member.timeout': 'admin.audit.action.member.timeout',
  'message.create': 'admin.audit.action.message.create',
  'message.delete': 'admin.audit.action.message.delete',
  'message.pin': 'admin.audit.action.message.pin',
  'message.unpin': 'admin.audit.action.message.unpin',
  'message.update': 'admin.audit.action.message.update',
  'poll.close': 'admin.audit.action.poll.close',
  'poll.create': 'admin.audit.action.poll.create',
  'role.create': 'admin.audit.action.role.create',
  'role.delete': 'admin.audit.action.role.delete',
  'role.update': 'admin.audit.action.role.update',
  'server.access_policy.update': 'admin.audit.action.server.access_policy.update',
  'server.banner.clear': 'admin.audit.action.server.banner.clear',
  'server.banner.update': 'admin.audit.action.server.banner.update',
  'user.email_verified_by_admin': 'admin.audit.action.user.email_verified_by_admin',
  'user.password_reset_by_operator': 'admin.audit.action.user.password_reset_by_operator',
  'voice.block_enforced': 'admin.audit.action.voice.block_enforced',
  'voice.disconnect': 'admin.audit.action.voice.disconnect',
  'voice.mute': 'admin.audit.action.voice.mute',
  'voice.track_rejected': 'admin.audit.action.voice.track_rejected',
  'voice.unmute': 'admin.audit.action.voice.unmute',
};

/** The catalogue key for an audit action's label, or null for one we do not know. */
export function auditActionLabelKey(action: string): string | null {
  return ACTION_LABEL_KEYS[action] ?? null;
}
