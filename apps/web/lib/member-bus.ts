/**
 * Member bus — "these members changed, re-read them" signals for the lobby
 * (docs/PROFILES.md "Live updates").
 *
 * Topic shape: `lf:{env}:members:{serverId}`; the WS gateway forwards it to
 * `members:{serverId}` subscribers (any member of the server).
 *
 * Like the presence bus, the payload names WHO changed and never what: a
 * profile is projected per viewer (profile visibility, blocks), so the
 * lobby re-reads the named members from
 * `GET /api/servers/{id}/lobby-members?ids=…` instead of trusting a
 * broadcast. The gateway drops anything but the three shapes below.
 *
 *   members-changed  joined, or profile / nickname / roles / timeout changed
 *   members-removed  left, kicked or banned
 *   roles-changed    a role itself changed (name, colour, icon, grouping,
 *                    order) or was deleted — re-read the whole list
 *
 * Fire-and-forget: a Redis blip never fails the request that changed
 * something; the lobby also re-reads everything after a reconnect.
 */
import { listServerIdsForUser } from '@lobbyforge/db';
import { getDb } from './db';
import { redis as sharedRedis } from './redis';

/** Most ids one event names — the gateway's cap; larger sets go out in chunks. */
export const MEMBER_EVENT_MAX_IDS = 100;

export type MemberBusEvent =
  | { type: 'members-changed' | 'members-removed'; userIds: string[] }
  | { type: 'roles-changed' };

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

export function memberTopicName(serverId: string): string {
  return `lf:${envPrefix()}:members:${serverId}`;
}

function publish(serverId: string, event: MemberBusEvent): void {
  try {
    sharedRedis.publish(memberTopicName(serverId), JSON.stringify(event)).catch((err: Error) => {
      console.warn(`[member-bus] publish failed for ${serverId}: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[member-bus] publish failed for ${serverId}: ${(err as Error).message}`);
  }
}

function publishIds(serverId: string, type: 'members-changed' | 'members-removed', userIds: readonly string[]): void {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += MEMBER_EVENT_MAX_IDS) {
    publish(serverId, { type, userIds: unique.slice(i, i + MEMBER_EVENT_MAX_IDS) });
  }
}

/** Joined, or their profile, nickname, roles or timeout changed. */
export function publishMembersChanged(serverId: string, userIds: readonly string[]): void {
  publishIds(serverId, 'members-changed', userIds);
}

/** Left, kicked or banned. */
export function publishMembersRemoved(serverId: string, userIds: readonly string[]): void {
  publishIds(serverId, 'members-removed', userIds);
}

/** A role changed or went away: every member list of the server re-reads. */
export function publishRolesChanged(serverId: string): void {
  publish(serverId, { type: 'roles-changed' });
}

/**
 * The account's own profile changed (name, handle, pronouns, colour,
 * avatar, banner, about, status): every community it belongs to hears it.
 * Best effort, after the response is decided — a failed lookup only means
 * the other lobbies catch up on their next reconnect or reload.
 */
export function publishProfileChanged(userId: string): void {
  // Never throws into the request that saved the profile — not even
  // synchronously (a database client that cannot be built).
  Promise.resolve()
    .then(() => listServerIdsForUser(getDb(), userId))
    .then((serverIds) => {
      for (const serverId of serverIds) publishMembersChanged(serverId, [userId]);
    })
    .catch((err: Error) => {
      console.warn(`[member-bus] server lookup failed: ${err.message}`);
    });
}
