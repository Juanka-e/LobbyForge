/**
 * An activity runs only while its app is installed and enabled in the
 * community (Server settings → Apps).
 *
 * The start route has always checked the install. Once a session was open,
 * though, uninstalling the app (`DELETE /api/servers/{id}/apps`) or
 * disabling it left the session accepting actions, its timers firing and
 * its storage being written. Now:
 *
 *  - the actions route refuses an action with `app_not_installed`;
 *  - a due timer is dropped without running (lib/activity-timers.ts);
 *  - storage writes and chat lines are dropped (lib/activity-effects.ts,
 *    lib/activity-app-chat.ts);
 *  - uninstalling or disabling the app ends its open sessions in the
 *    community (`endAppSessions`), audited as `activity.end` like a
 *    member ending one, with the reason.
 */
import { endOpenGameSessionsForPlugin, getPluginInstall, logAction, type DbClient } from '@lobbyforge/db';
import { publishActivityStateChange } from './activity-bus';

/** Is the app installed and enabled in this community? A read failure throws (callers fail closed). */
export async function isAppEnabled(db: DbClient, serverId: string, pluginId: string): Promise<boolean> {
  const install = await getPluginInstall(db, serverId, pluginId);
  return !!install && install.enabled === true;
}

export type AppSessionEndReason = 'app_uninstalled' | 'app_disabled';

/**
 * End every open session of `pluginId` in the community — nothing fires on
 * the way out (the app is gone). Each ended session is published on the
 * activity bus (open panels close) and audited as `activity.end` with the
 * member who removed the app as the actor. Returns how many were ended.
 */
export async function endAppSessions(
  db: DbClient,
  input: { serverId: string; pluginId: string; actorUserId: string; reason: AppSessionEndReason }
): Promise<number> {
  const ended = await endOpenGameSessionsForPlugin(db, input.serverId, input.pluginId);
  for (const row of ended) {
    publishActivityStateChange({
      serverId: row.serverId,
      sessionId: row.id,
      status: row.status,
      publicSummary: row.publicSummary,
    });
    void logAction(db, {
      serverId: input.serverId,
      actorUserId: input.actorUserId,
      action: 'activity.end',
      targetType: 'session',
      targetId: row.id,
      metadata: { pluginId: input.pluginId, wasHost: row.createdBy === input.actorUserId, reason: input.reason },
    }).catch((err) => console.error('[audit] activity.end (app removed) failed:', (err as Error).message));
  }
  return ended.length;
}
