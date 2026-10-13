/**
 * What a viewer may do to a member — the profile card's `viewerCan`.
 *
 * The moderation routes decide through `authorizeModerationTarget`
 * (lib/member-authorization.ts). The card must offer exactly what those
 * routes would accept, so the rules live here ONCE, as pure functions over
 * facts the caller has already read, and the gate imports its permission
 * map and rank comparison from this module:
 *
 *   actor not a member (and not the owner) → nothing
 *   missing the operation's permission    → no (the owner holds them all)
 *   timed-out actor                       → no (never the owner)
 *   the member is the actor               → no
 *   the member owns the server            → no
 *   the member is not a member            → only a ban
 *   owner actor                           → yes
 *   otherwise                             → the actor's highest role must be STRICTLY above the member's
 *
 * Role assignment adds the role route's own rules: a non-owner may hand
 * out only roles strictly below their highest role, and only roles whose
 * permissions they could grant themselves (lib/role-grant-policy.ts);
 * `@everyone` is never offered or removed. The UI reads the result; the
 * routes still check everything again.
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { findUngrantablePermissions } from '@/lib/role-grant-policy';
import type { ProfileRoleView, ViewerCapabilities } from '@/lib/member-profile';

export type ModerationOperation = 'kick' | 'ban' | 'timeout' | 'set_roles' | 'voice_mute' | 'voice_disconnect';

export const MODERATION_OPERATION_PERMISSION: Readonly<Record<ModerationOperation, CorePermission>> = {
  kick: CorePermission.KICK_MEMBERS,
  ban: CorePermission.BAN_MEMBERS,
  timeout: CorePermission.MODERATE_MEMBERS,
  set_roles: CorePermission.MANAGE_ROLES,
  voice_mute: CorePermission.MUTE_MEMBERS,
  // There is no move-members permission: Mute Members also allows
  // disconnecting someone from a voice room (docs/ROLES.md).
  voice_disconnect: CorePermission.MUTE_MEMBERS,
};

/**
 * Pure hierarchy check: actor's highest role strictly above the
 * target's. Equal rank cannot moderate equal rank.
 */
export function isActorAboveTarget(actorHighest: number, targetHighest: number): boolean {
  return actorHighest > targetHighest;
}

export interface ModerationFacts {
  actorIsOwner: boolean;
  /** A current member of the server (no active ban). */
  actorIsMember: boolean;
  actorPermissions: readonly string[];
  /** The actor has an active timeout in this server. */
  actorTimedOut: boolean;
  /** `getHighestRolePosition` — +Infinity for the owner, -1 with no role. */
  actorHighest: number;
  isSelf: boolean;
  targetIsOwner: boolean;
  targetIsMember: boolean;
  targetHighest: number;
}

/** Would `authorizeModerationTarget` let this actor do `operation` to this member? */
export function mayModerate(operation: ModerationOperation, facts: ModerationFacts): boolean {
  if (!facts.actorIsOwner && !facts.actorIsMember) return false;
  if (!facts.actorIsOwner && !hasPermission([...facts.actorPermissions], MODERATION_OPERATION_PERMISSION[operation])) {
    return false;
  }
  if (!facts.actorIsOwner && facts.actorTimedOut) return false;
  if (facts.isSelf) return false;
  if (facts.targetIsOwner) return false;
  if (!facts.targetIsMember) return operation === 'ban';
  if (facts.actorIsOwner) return true;
  return isActorAboveTarget(facts.actorHighest, facts.targetHighest);
}

export interface CapabilityRole extends ProfileRoleView {
  permissions: readonly string[];
}

export const EVERYONE_ROLE_NAME = '@everyone';

function toView(role: CapabilityRole): ProfileRoleView {
  return { id: role.id, name: role.name, color: role.color, icon: role.icon, position: role.position };
}

/**
 * The full `viewerCan` block. `serverRoles` is every role in the server
 * (only read when the viewer may manage this member's roles);
 * `targetRoles` is every role the member holds, `@everyone` included.
 */
export function computeViewerCapabilities(input: {
  facts: ModerationFacts;
  targetRoles: readonly CapabilityRole[];
  serverRoles: readonly CapabilityRole[];
  /** Not yourself and no block in either direction (the DM route's own 403s). */
  canMessage: boolean;
}): ViewerCapabilities {
  const { facts, targetRoles, serverRoles } = input;
  const manageRoles = mayModerate('set_roles', facts);
  const held = new Set(targetRoles.map((role) => role.id));

  const assignableRoles = manageRoles
    ? serverRoles
        .filter((role) => role.name !== EVERYONE_ROLE_NAME && !held.has(role.id))
        .filter((role) => {
          if (facts.actorIsOwner) return true;
          if (role.position >= facts.actorHighest) return false;
          return (
            findUngrantablePermissions({
              actorIsOwner: false,
              actorPermissions: facts.actorPermissions,
              requested: role.permissions,
            }).length === 0
          );
        })
        .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
        .map(toView)
    : [];

  // Every role the member holds sits below the actor (the actor outranks
  // the member, or is the owner), so each may come off — except @everyone.
  const removableRoleIds = manageRoles
    ? targetRoles.filter((role) => role.name !== EVERYONE_ROLE_NAME).map((role) => role.id)
    : [];

  return {
    isSelf: facts.isSelf,
    message: input.canMessage && !facts.isSelf,
    kick: mayModerate('kick', facts),
    ban: mayModerate('ban', facts),
    timeout: mayModerate('timeout', facts),
    serverMute: mayModerate('voice_mute', facts),
    manageRoles,
    assignableRoles,
    removableRoleIds,
    currentRoleIds: manageRoles ? targetRoles.map((role) => role.id) : [],
  };
}
