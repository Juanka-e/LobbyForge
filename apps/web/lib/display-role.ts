/**
 * The role a member is shown with — the Members page's Role column, the
 * lobby member list's name colour: the highest-positioned role they hold
 * other than `@everyone`, or null (shown as "Member" / "Guest"). A tie goes
 * to the role listed first.
 *
 * The same rule as `pickDisplayRole` in `@lobbyforge/db` (which stores it
 * in `memberships.role_id` and derives it for every list the server
 * renders); this copy is for client components that update a row after a
 * role change, and cannot import the database package.
 */
export const EVERYONE_ROLE_NAME = '@everyone';

export function displayRoleOf<T extends { name: string; position: number }>(roles: readonly T[]): T | null {
  let best: T | null = null;
  for (const role of roles) {
    if (role.name === EVERYONE_ROLE_NAME) continue;
    if (!best || role.position > best.position) best = role;
  }
  return best;
}
