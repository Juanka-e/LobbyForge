/**
 * Which members the viewer may disconnect from voice — the lobby hides
 * the voice roster's "Disconnect from voice" for everyone else.
 *
 * Mirrors the hierarchy the route enforces (lib/member-authorization.ts):
 * the owner outranks everyone; otherwise the viewer's highest role must
 * sit STRICTLY above the target's; nobody targets themselves or the
 * owner. A member with no role ranks -1, like `getHighestRolePosition`.
 *
 * This is a display hint computed from the member list the page already
 * loads (multi-role rows, which the display role is mirrored into). The
 * route is the authority: a stale list can only hide a control, or show
 * one that then answers with a translated refusal.
 */

export interface RankedMember {
  userId: string;
  roles: ReadonlyArray<{ position: number }>;
}

function highestPosition(member: RankedMember | undefined): number {
  if (!member || member.roles.length === 0) return -1;
  return Math.max(...member.roles.map((role) => role.position));
}

export function listVoiceModerationTargets(input: {
  members: readonly RankedMember[];
  viewerUserId: string | null;
  ownerUserId: string | null;
}): string[] {
  const { members, viewerUserId, ownerUserId } = input;
  if (!viewerUserId) return [];
  const viewerIsOwner = ownerUserId !== null && ownerUserId === viewerUserId;
  const viewerRank = viewerIsOwner
    ? Number.POSITIVE_INFINITY
    : highestPosition(members.find((member) => member.userId === viewerUserId));
  return members
    .filter(
      (member) =>
        member.userId !== viewerUserId &&
        member.userId !== ownerUserId &&
        viewerRank > highestPosition(member)
    )
    .map((member) => member.userId);
}
