/**
 * Role permission-grant policy (beta-review S1).
 *
 * The role routes only checked that requested permissions were KNOWN and
 * that the edited role sat below the actor. A member with MANAGE_ROLES
 * could therefore PATCH `@everyone` (position 0 — always below them)
 * with `administrator` and hand every member audit-log / ban access
 * (live-confirmed). Discord's rule, applied to role create, role edit
 * and role assignment:
 *
 *   owner      → may grant anything (unchanged);
 *   non-owner  → may only ADD permissions they hold themselves
 *                (`hasPermission`, so an administrator holds every
 *                permission) and may NEVER add `administrator`.
 *
 * Only ADDITIONS are policed: permissions a role already carries (set by
 * the owner) may stay when a lower manager renames/recolours it, and
 * removing a permission is always a de-escalation.
 */
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';

export function findUngrantablePermissions(input: {
  actorIsOwner: boolean;
  actorPermissions: readonly string[];
  requested: readonly string[] | null | undefined;
  /** Permissions the target role already carries (not a new grant). */
  alreadyGranted?: readonly string[] | null;
}): string[] {
  if (input.actorIsOwner) return [];
  const existing = new Set(input.alreadyGranted ?? []);
  const actor = [...input.actorPermissions];
  const out = new Set<string>();
  for (const permission of input.requested ?? []) {
    if (existing.has(permission)) continue;
    if (permission === CorePermission.ADMINISTRATOR) {
      out.add(permission);
      continue;
    }
    if (!hasPermission(actor, permission as CorePermissionT)) out.add(permission);
  }
  return Array.from(out);
}

export const UNGRANTABLE_PERMISSIONS_ERROR =
  'You cannot grant permissions you do not have (only the server owner may grant administrator)';
