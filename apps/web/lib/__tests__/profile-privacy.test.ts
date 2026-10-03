import { describe, expect, it } from 'vitest';
import type { ActivityVisibilityScope, DmChannelSummary, MemberSummary, UserBlockRow } from '@lobbyforge/db';
import {
  canViewProfile,
  projectBlockedUser,
  projectDmChannel,
  projectMemberProfile,
} from '@/lib/profile-privacy';

const VIEWER = '00000000-0000-0000-0000-00000000000a';
const MEMBER = '00000000-0000-0000-0000-00000000000b';

function summary(
  profileVisibility: ActivityVisibilityScope,
  overrides: Partial<MemberSummary> = {}
): MemberSummary {
  return {
    userId: MEMBER,
    displayName: 'Alice',
    globalDisplayName: 'Alice',
    nickname: null,
    avatarRef: '0123456789ab',
    bannerRef: 'abcdefabcdef',
    profileVisibility,
    isGuest: false,
    roleName: null,
    roleColor: null,
    roleIcon: null,
    statusText: 'In a match',
    bio: 'Plays support',
    roles: [],
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const VISIBLE = {
  avatarUrl: `/api/users/${MEMBER}/avatar?v=0123456789ab`,
  bannerRef: 'abcdefabcdef',
  statusText: 'In a match',
  bio: 'Plays support',
};
const HIDDEN = { avatarUrl: null, bannerRef: null, statusText: null, bio: null };

describe('canViewProfile — security-review AUTHZ-005', () => {
  const stranger = { isSelf: false, sharesServer: false };
  const coMember = { isSelf: false, sharesServer: true };
  const self = { isSelf: true, sharesServer: false };

  it('everyone: any signed-in viewer', () => {
    expect(canViewProfile('everyone', stranger)).toBe(true);
    expect(canViewProfile('everyone', coMember)).toBe(true);
  });

  it('server_members: only viewers who share a server', () => {
    expect(canViewProfile('server_members', stranger)).toBe(false);
    expect(canViewProfile('server_members', coMember)).toBe(true);
  });

  it('friends: enforced as server members (no friends system; the UI shows it that way)', () => {
    expect(canViewProfile('friends', stranger)).toBe(false);
    expect(canViewProfile('friends', coMember)).toBe(true);
  });

  it('nobody: no one but the user', () => {
    expect(canViewProfile('nobody', stranger)).toBe(false);
    expect(canViewProfile('nobody', coMember)).toBe(false);
  });

  it('the user always sees their own profile', () => {
    for (const scope of ['everyone', 'server_members', 'friends', 'nobody'] as const) {
      expect(canViewProfile(scope, self)).toBe(true);
    }
  });

  it('an unknown scope fails closed', () => {
    expect(canViewProfile('admins' as ActivityVisibilityScope, coMember)).toBe(false);
  });
});

describe('projectMemberProfile — lobby member list', () => {
  it.each([
    ['everyone', VISIBLE],
    ['server_members', VISIBLE],
    ['friends', VISIBLE],
    ['nobody', HIDDEN],
  ] as const)('%s → co-member viewer sees the expected fields', (scope, expected) => {
    expect(projectMemberProfile(summary(scope), VIEWER)).toEqual(expected);
  });

  it('a member always sees their own full profile, even with "nobody"', () => {
    expect(projectMemberProfile(summary('nobody'), MEMBER)).toEqual(VISIBLE);
  });

  it('server_members hides from a viewer who shares no server', () => {
    expect(projectMemberProfile(summary('server_members'), VIEWER, { sharesServer: false })).toEqual(HIDDEN);
  });

  it('hides everything from a signed-out render', () => {
    expect(projectMemberProfile(summary('server_members'), null, { sharesServer: false })).toEqual(HIDDEN);
  });

  it('security-review FILE-001: the member payload never carries a data URL', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(4096)}`;
    const members = [
      projectMemberProfile(summary('everyone', { avatarRef: dataUrl, bannerRef: dataUrl }), VIEWER),
      projectMemberProfile(summary('everyone'), VIEWER),
      projectMemberProfile(summary('nobody'), VIEWER),
    ];
    const payload = JSON.stringify(members);
    expect(payload).not.toContain('data:');
    expect(members[0]).toEqual({ ...VISIBLE, avatarUrl: null, bannerRef: null });
  });
});

describe('projectDmChannel — DM list', () => {
  const lastMessageAt = new Date('2026-01-02T00:00:00Z');
  function channel(
    otherUserProfileVisibility: ActivityVisibilityScope,
    sharesServerWithOtherUser: boolean
  ): DmChannelSummary {
    return {
      id: 'dm-1',
      otherUserId: MEMBER,
      otherUserDisplayName: 'Alice',
      otherUserAvatarRef: '0123456789ab',
      otherUserProfileVisibility,
      sharesServerWithOtherUser,
      lastMessageAt,
    };
  }

  it('keeps the API shape and links the avatar route', () => {
    expect(projectDmChannel(channel('everyone', false), VIEWER)).toEqual({
      id: 'dm-1',
      otherUserId: MEMBER,
      otherUserDisplayName: 'Alice',
      otherUserAvatarUrl: `/api/users/${MEMBER}/avatar?v=0123456789ab`,
      lastMessageAt,
    });
  });

  it.each([
    ['everyone', false, true],
    ['server_members', true, true],
    ['server_members', false, false],
    ['friends', false, false],
    ['nobody', true, false],
  ] as const)('%s (shares a server: %s) → avatar shown: %s', (scope, shares, shown) => {
    const view = projectDmChannel(channel(scope, shares), VIEWER);
    expect(view.otherUserAvatarUrl !== null).toBe(shown);
    expect(view.otherUserDisplayName).toBe('Alice');
  });
});

describe('projectBlockedUser — block list', () => {
  function row(blockedProfileVisibility: ActivityVisibilityScope): UserBlockRow {
    return {
      id: 'b-1',
      blockerUserId: VIEWER,
      blockedUserId: MEMBER,
      blockedDisplayName: 'Alice',
      blockedAvatarRef: '0123456789ab',
      blockedProfileVisibility,
      sharesServerWithBlocked: true,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    };
  }

  it('links the avatar when visible and drops it for "nobody"', () => {
    expect(projectBlockedUser(row('server_members')).blockedAvatarUrl).toBe(
      `/api/users/${MEMBER}/avatar?v=0123456789ab`
    );
    const hidden = projectBlockedUser(row('nobody'));
    expect(hidden.blockedAvatarUrl).toBeNull();
    expect(hidden.blockedDisplayName).toBe('Alice');
    expect(hidden).not.toHaveProperty('blockedAvatarRef');
  });
});
