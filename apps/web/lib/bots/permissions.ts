/**
 * Bot permission policy (server-only).
 *
 * Bot permissions are a SEPARATE vocabulary from member permissions: a
 * bot never goes through `getUserPermissions`/`hasPermission`, holds no
 * roles, and no bot permission maps to `administrator`. What a bot may do
 * is exactly the list stored on its row, checked by every Bot API route
 * and by the built-in bots before they act. The ids themselves live in
 * the client-safe `./catalog.ts`.
 */
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';
import { isBotPermission, type BotPermissionId } from './catalog';

export * from './catalog';

/**
 * The member permission a manager must hold to hand a permission to a
 * bot — you cannot give a bot more than you have (Discord's rule, the
 * same one `role-grant-policy.ts` applies to roles). `null`: any bot
 * manager may grant it. Administrators hold everything.
 */
export const BOT_PERMISSION_REQUIRES: Record<BotPermissionId, CorePermissionT | null> = {
  read_messages: CorePermission.READ_MESSAGE_HISTORY,
  send_messages: CorePermission.SEND_MESSAGES,
  join_voice: CorePermission.CONNECT_VOICE,
  publish_audio: CorePermission.SPEAK,
  read_presence: null,
  moderate_messages: CorePermission.MANAGE_MESSAGES,
  manage_game_session: CorePermission.START_ACTIVITY,
  manage_music_queue: CorePermission.START_ACTIVITY,
  read_audit_log: CorePermission.VIEW_AUDIT_LOG,
  // A command answer is a message in the channel, so handing out commands
  // takes the right to post yourself (BOT_API_V2 §1.2).
  slash_commands: CorePermission.SEND_MESSAGES,
  // Member join/leave and member lookups show names every member already
  // sees in the member list; the event stream itself grants nothing.
  read_members: null,
  receive_events: null,
};

export function botHasPermission(
  bot: { permissions: readonly string[] },
  permission: BotPermissionId
): boolean {
  return bot.permissions.includes(permission);
}

/**
 * Which requested bot permissions this manager may NOT grant. Only
 * additions are policed — keeping a permission the bot already has, or
 * removing one, is never an escalation. Unknown ids are always refused.
 */
export function findUngrantableBotPermissions(input: {
  actorIsOwner: boolean;
  actorPermissions: readonly string[];
  requested: readonly string[];
  alreadyGranted?: readonly string[];
}): string[] {
  const existing = new Set(input.alreadyGranted ?? []);
  const out: string[] = [];
  for (const permission of input.requested) {
    if (!isBotPermission(permission)) {
      out.push(permission);
      continue;
    }
    if (input.actorIsOwner || existing.has(permission)) continue;
    const required = BOT_PERMISSION_REQUIRES[permission];
    if (required && !hasPermission([...input.actorPermissions], required)) out.push(permission);
  }
  return out;
}
