import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The profile card's `viewerCan` (lib/member-capabilities.ts) must offer
 * exactly what the moderation gate (`authorizeModerationTarget`) accepts.
 * The first suite runs BOTH over every combination of the facts that
 * matter and compares the answers; the rest pin the role rules.
 */

const dbFns = {
  getActiveMemberTimeout: vi.fn(),
  getHighestRolePosition: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  userExists: vi.fn(),
};
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));

const SERVER = 'srv';
const OWNER = 'owner';
const ACTOR = 'actor';
const TARGET = 'target';

const OPERATIONS = ['kick', 'ban', 'timeout', 'set_roles', 'voice_mute', 'voice_disconnect'] as const;

beforeEach(() => {
  for (const fn of Object.values(dbFns)) fn.mockReset();
});

describe('mayModerate agrees with authorizeModerationTarget', () => {
  it('over every combination of actor, target, permission, timeout and rank', async () => {
    const { authorizeModerationTarget } = await import('@/lib/member-authorization');
    const { mayModerate, MODERATION_OPERATION_PERMISSION } = await import('@/lib/member-capabilities');
    let compared = 0;
    for (const operation of OPERATIONS) {
      for (const actorIsOwner of [true, false]) {
        for (const actorIsMember of actorIsOwner ? [true] : [true, false]) {
          for (const hasPermission of [true, false]) {
            for (const actorTimedOut of [true, false]) {
              for (const targetKind of ['self', 'owner', 'other'] as const) {
                if (actorIsOwner && targetKind === 'owner') continue; // that is "self"
                for (const targetIsMember of targetKind === 'other' ? [true, false] : [true]) {
                  for (const targetHighest of [6, 5, 4]) {
                    const actorId = actorIsOwner ? OWNER : ACTOR;
                    const targetId = targetKind === 'self' ? actorId : targetKind === 'owner' ? OWNER : TARGET;
                    const actorHighest = actorIsOwner ? Number.POSITIVE_INFINITY : 5;
                    const resolvedTargetHighest = targetId === OWNER ? Number.POSITIVE_INFINITY : targetId === actorId ? actorHighest : targetHighest;
                    const permissions = actorIsOwner ? ['administrator'] : hasPermission ? [MODERATION_OPERATION_PERMISSION[operation]] : ['send_messages'];

                    dbFns.getServerById.mockResolvedValue({ id: SERVER, ownerUserId: OWNER });
                    dbFns.isServerMember.mockImplementation(async (_db: unknown, userId: string) =>
                      userId === actorId ? actorIsMember : userId === OWNER ? true : targetIsMember
                    );
                    dbFns.getUserPermissions.mockResolvedValue(permissions);
                    dbFns.getActiveMemberTimeout.mockResolvedValue(actorTimedOut ? new Date(Date.now() + 60_000) : null);
                    dbFns.getHighestRolePosition.mockImplementation(async (_db: unknown, _s: string, userId: string) =>
                      userId === OWNER ? Number.POSITIVE_INFINITY : userId === actorId ? actorHighest : resolvedTargetHighest
                    );
                    dbFns.userExists.mockResolvedValue(true);

                    const gate = await authorizeModerationTarget({ operation, serverId: SERVER, actorUserId: actorId, targetUserId: targetId });
                    const offered = mayModerate(operation, {
                      actorIsOwner,
                      actorIsMember,
                      actorPermissions: permissions,
                      actorTimedOut,
                      actorHighest,
                      isSelf: targetId === actorId,
                      targetIsOwner: targetId === OWNER,
                      targetIsMember: targetId === actorId ? actorIsMember : targetId === OWNER ? true : targetIsMember,
                      targetHighest: resolvedTargetHighest,
                    });
                    expect(
                      offered,
                      JSON.stringify({ operation, actorIsOwner, actorIsMember, hasPermission, actorTimedOut, targetKind, targetIsMember, targetHighest })
                    ).toBe(gate.ok);
                    compared += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });
});

describe('computeViewerCapabilities: roles', () => {
  const everyone = { id: 'e', name: '@everyone', color: null, icon: null, position: 0, permissions: ['send_messages'] };
  const low = { id: 'low', name: 'Low', color: null, icon: null, position: 1, permissions: [] };
  const kickers = { id: 'kick', name: 'Kickers', color: '#112233', icon: 'gavel', position: 3, permissions: ['kick_members'] };
  const banners = { id: 'ban', name: 'Banners', color: null, icon: null, position: 4, permissions: ['ban_members'] };
  const adminLow = { id: 'adm', name: 'Sneaky', color: null, icon: null, position: 2, permissions: ['administrator'] };
  const mine = { id: 'mine', name: 'Mine', color: null, icon: null, position: 6, permissions: ['manage_roles', 'kick_members'] };
  const roles = [everyone, low, adminLow, kickers, banners, mine];

  const facts = {
    actorIsOwner: false,
    actorIsMember: true,
    actorPermissions: ['manage_roles', 'kick_members'],
    actorTimedOut: false,
    actorHighest: 6,
    isSelf: false,
    targetIsOwner: false,
    targetIsMember: true,
    targetHighest: 1,
  };

  it('offers roles below the actor that carry only permissions the actor holds, never @everyone or a held role', async () => {
    const { computeViewerCapabilities } = await import('@/lib/member-capabilities');
    const can = computeViewerCapabilities({ facts, targetRoles: [low, everyone], serverRoles: roles, canMessage: true });
    expect(can.manageRoles).toBe(true);
    expect(can.assignableRoles.map((r) => r.id)).toEqual(['kick']);
    expect(can.assignableRoles[0]).toEqual({ id: 'kick', name: 'Kickers', color: '#112233', icon: 'gavel', position: 3 });
    expect(can.removableRoleIds).toEqual(['low']);
    expect(can.currentRoleIds).toEqual(['low', 'e']);
  });

  it('an administrator may grant any permission except administrator itself', async () => {
    const { computeViewerCapabilities } = await import('@/lib/member-capabilities');
    const can = computeViewerCapabilities({
      facts: { ...facts, actorPermissions: ['administrator'] },
      targetRoles: [everyone],
      serverRoles: roles,
      canMessage: true,
    });
    expect(can.assignableRoles.map((r) => r.id)).toEqual(['ban', 'kick', 'low']);
  });

  it('the owner may hand out every role but @everyone', async () => {
    const { computeViewerCapabilities } = await import('@/lib/member-capabilities');
    const can = computeViewerCapabilities({
      facts: { ...facts, actorIsOwner: true, actorPermissions: ['administrator'], actorHighest: Number.POSITIVE_INFINITY },
      targetRoles: [everyone],
      serverRoles: roles,
      canMessage: true,
    });
    expect(can.assignableRoles.map((r) => r.id)).toEqual(['mine', 'ban', 'kick', 'adm', 'low']);
  });

  it('without Manage Roles: no role controls at all, and no role list read', async () => {
    const { computeViewerCapabilities } = await import('@/lib/member-capabilities');
    const can = computeViewerCapabilities({
      facts: { ...facts, actorPermissions: ['kick_members'] },
      targetRoles: [low, everyone],
      serverRoles: roles,
      canMessage: true,
    });
    expect(can).toMatchObject({ manageRoles: false, assignableRoles: [], removableRoleIds: [], currentRoleIds: [], kick: true });
  });

  it('message is never offered to yourself', async () => {
    const { computeViewerCapabilities } = await import('@/lib/member-capabilities');
    const can = computeViewerCapabilities({ facts: { ...facts, isSelf: true }, targetRoles: [], serverRoles: [], canMessage: true });
    expect(can.message).toBe(false);
    expect(can.isSelf).toBe(true);
  });
});
