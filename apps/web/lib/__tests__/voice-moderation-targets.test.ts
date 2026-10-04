/**
 * Who the voice roster offers "Disconnect from voice" for — the same
 * hierarchy the route enforces: the owner outranks everyone, otherwise
 * strictly above; never yourself, never the owner.
 */
import { describe, expect, it } from 'vitest';
import { listVoiceModerationTargets, type RankedMember } from '@/lib/voice-moderation-targets';

const member = (userId: string, ...positions: number[]): RankedMember => ({
  userId,
  roles: positions.map((position) => ({ position })),
});

const MEMBERS = [
  member('owner', 100),
  member('admin', 80, 5),
  member('mod', 50),
  member('peer', 50),
  member('helper', 30, 10),
  member('plain'),
];

describe('listVoiceModerationTargets', () => {
  it('a moderator gets only the members strictly below their highest role', () => {
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: 'mod', ownerUserId: 'owner' })).toEqual([
      'helper',
      'plain',
    ]);
  });

  it('uses each member’s HIGHEST role', () => {
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: 'admin', ownerUserId: 'owner' })).toEqual([
      'mod',
      'peer',
      'helper',
      'plain',
    ]);
  });

  it('the owner gets everyone but themselves', () => {
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: 'owner', ownerUserId: 'owner' })).toEqual([
      'admin',
      'mod',
      'peer',
      'helper',
      'plain',
    ]);
  });

  it('never the owner, even for a viewer ranked above the owner’s roles', () => {
    const members = [member('owner'), member('admin', 90)];
    expect(listVoiceModerationTargets({ members, viewerUserId: 'admin', ownerUserId: 'owner' })).toEqual([]);
  });

  it('nobody for a viewer without roles, a viewer who is not listed, or no viewer', () => {
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: 'plain', ownerUserId: 'owner' })).toEqual([]);
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: 'stranger', ownerUserId: 'owner' })).toEqual([]);
    expect(listVoiceModerationTargets({ members: MEMBERS, viewerUserId: null, ownerUserId: 'owner' })).toEqual([]);
  });
});
