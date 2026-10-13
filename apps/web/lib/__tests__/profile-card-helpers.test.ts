import { describe, expect, it } from 'vitest';
import {
  bannerBandColor,
  dominantColor,
  isSameOriginPath,
  roleAccentColor,
  sampleAvatarColor,
  THEME_ACCENT_COLOR,
  toCssColor,
} from '@/lib/profile-accent';
import { profileActionErrorMessage } from '@/lib/profile-action-errors';
import { mergeProfileView, type MemberProfileResponse, type ProfileSeed } from '@/lib/member-profile';

/**
 * The profile card's pure helpers (docs/PROFILES.md): the banner band's
 * colour, refusal messages from the routes' codes, and how the lobby's
 * seed and the API's answer are merged without bringing back anything the
 * server withheld.
 */

function pixels(...rgba: Array<[number, number, number, number]>): number[] {
  return rgba.flat();
}

describe('banner band colour', () => {
  it('the dominant colour of the opaque pixels', () => {
    const data = pixels([200, 20, 20, 255], [210, 25, 24, 255], [10, 10, 200, 255], [0, 255, 0, 0], [0, 255, 0, 10]);
    expect(dominantColor(data)).toEqual({ r: 205, g: 23, b: 22 });
    expect(toCssColor({ r: 203, g: 33, b: 31 })).toBe('rgb(203, 33, 31)');
  });

  it('nothing opaque, nothing sampled', () => {
    expect(dominantColor(pixels([1, 2, 3, 0]))).toBeNull();
    expect(dominantColor([])).toBeNull();
  });

  it('samples only same-origin paths (an external image would taint the canvas)', async () => {
    expect(isSameOriginPath('/api/users/u/avatar?v=abc')).toBe(true);
    expect(isSameOriginPath('//evil.example/a.png')).toBe(false);
    expect(isSameOriginPath('https://cdn.example/a.png')).toBe(false);
    expect(isSameOriginPath(null)).toBe(false);
    await expect(sampleAvatarColor('https://cdn.example/a.png')).resolves.toBeNull();
  });

  it('falls back to the highest valid role colour, then the theme accent variable', () => {
    expect(roleAccentColor([{ color: null }, { color: 'red' }, { color: '#22AA66' }])).toBe('#22AA66');
    expect(bannerBandColor('rgb(1, 2, 3)', [{ color: '#22aa66' }])).toBe('rgb(1, 2, 3)');
    expect(bannerBandColor(null, [{ color: '#22aa66' }])).toBe('#22aa66');
    expect(bannerBandColor(null, [])).toBe(THEME_ACCENT_COLOR);
    expect(THEME_ACCENT_COLOR).toMatch(/^var\(--lf-user-accent/);
  });
});

describe('refusal messages', () => {
  it('from the moderation gate’s codes', () => {
    expect(profileActionErrorMessage('kick', { status: 403, code: 'insufficient_rank' }).key).toBe('shell.profile.error.rank');
    expect(profileActionErrorMessage('timeout', { status: 403, code: 'actor_timed_out' }).key).toBe('shell.profile.error.timedOut');
    expect(profileActionErrorMessage('ban', { status: 403, code: 'target_is_owner' }).key).toBe('shell.profile.error.owner');
    expect(profileActionErrorMessage('kick', { status: 404, code: 'target_not_member' }).key).toBe('shell.profile.error.notMember');
    expect(profileActionErrorMessage('mute', { status: 403, code: 'forbidden' }).key).toBe('shell.profile.error.forbidden');
  });

  it('the role route’s own refusals, a duplicate ban, rate limits and the rest', () => {
    expect(profileActionErrorMessage('roles', { status: 403, permissions: ['ban_members'] }).key).toBe('shell.profile.error.roleGrant');
    expect(profileActionErrorMessage('roles', { status: 403 }).key).toBe('shell.profile.error.roleRank');
    expect(profileActionErrorMessage('ban', { status: 409 }).key).toBe('shell.profile.error.alreadyBanned');
    expect(profileActionErrorMessage('kick', { status: 429 }).key).toBe('shell.profile.error.rateLimited');
    expect(profileActionErrorMessage('kick', { status: 500 })).toEqual({ key: 'shell.profile.error.generic', params: { status: 500 } });
  });

  it('a DM refusal never says why (blocked or not)', () => {
    expect(profileActionErrorMessage('message', { status: 403 }).key).toBe('shell.profile.error.cannotMessage');
    expect(profileActionErrorMessage('message', { status: 404 }).key).toBe('shell.profile.error.cannotMessage');
  });
});

describe('mergeProfileView', () => {
  const seed: ProfileSeed = {
    userId: 'u1',
    displayName: 'Ace',
    avatarUrl: '/api/users/u1/avatar?v=aaa',
    bio: 'seed bio',
    statusText: 'seed status',
    presence: 'dnd',
    inVoice: true,
    roles: [
      { id: 'e', name: '@everyone', color: null, icon: null, position: 0 },
      { id: 'r', name: 'Veteran', color: null, icon: null, position: 3 },
    ],
  };

  function api(profile: Partial<MemberProfileResponse['profile']>): MemberProfileResponse {
    return {
      profile: {
        userId: 'u1',
        displayName: 'Ace',
        globalDisplayName: 'Alice',
        nickname: 'Ace',
        avatarUrl: '/api/users/u1/avatar?v=aaa',
        bannerUrl: null,
        isGuest: false,
        statusText: 'api status',
        bio: 'api bio',
        presence: 'online',
        roles: [],
        memberSince: null,
        accountCreatedAt: null,
        mutualServers: [],
        mutualServerCount: 0,
        blockedByMe: false,
        limited: false,
        isOwner: false,
        timedOutUntil: null,
        ...profile,
      },
      viewerCan: {
        isSelf: false,
        message: true,
        kick: false,
        ban: false,
        timeout: false,
        serverMute: false,
        manageRoles: false,
        assignableRoles: [],
        removableRoleIds: [],
        currentRoleIds: [],
      },
    };
  }

  it('the seed until the API answers (without @everyone)', () => {
    const view = mergeProfileView(seed, null);
    expect(view).toMatchObject({ bio: 'seed bio', presence: 'dnd', inVoice: true, loaded: false });
    expect(view.roles.map((r) => r.id)).toEqual(['r']);
  });

  it('the API wins for everything it projects — a withheld field never comes back from the seed', () => {
    const view = mergeProfileView(seed, api({ bio: null, statusText: null, avatarUrl: null, limited: true }));
    expect(view).toMatchObject({ bio: null, statusText: null, avatarUrl: null, limited: true, loaded: true });
  });

  it('presence: the live seed beats the API snapshot, unless the API withholds it; yours is what you picked', () => {
    expect(mergeProfileView(seed, api({ presence: 'online' })).presence).toBe('dnd');
    expect(mergeProfileView(seed, api({ presence: null })).presence).toBeNull();
    expect(mergeProfileView({ ...seed, presence: null }, api({ presence: 'idle' })).presence).toBe('idle');
    expect(mergeProfileView(seed, api({}), 'offline').presence).toBe('offline');
  });
});
