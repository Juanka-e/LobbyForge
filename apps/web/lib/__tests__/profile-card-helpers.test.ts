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
import {
  adminRefusalText,
  KNOWN_REFUSAL_CODES,
  profileActionErrorMessage,
  timedOutRefusalKey,
} from '@/lib/profile-action-errors';
import { translatorFor } from '@/lib/i18n/catalogue';
import enShell from '@/messages/en/shell.json';
import trShell from '@/messages/tr/shell.json';
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

  // The A-to-Z run: the kick, ban, role and timeout routes' refusals before
  // the shared gate had no code; they do now, and each is said in words.
  it('the codes the routes send before (and beside) the moderation gate', () => {
    expect(profileActionErrorMessage('kick', { status: 401, code: 'unauthenticated' }).key).toBe('shell.profile.error.signIn');
    expect(profileActionErrorMessage('ban', { status: 503, code: 'session_not_materialized' }).key).toBe('shell.profile.error.signIn');
    expect(profileActionErrorMessage('kick', { status: 404, code: 'server_not_found' }).key).toBe('shell.profile.error.serverGone');
    expect(profileActionErrorMessage('ban', { status: 400, code: 'invalid_request' }).key).toBe('shell.profile.error.invalidRequest');
    expect(profileActionErrorMessage('ban', { status: 400, code: 'self_action' }).key).toBe('shell.profile.error.self');
    expect(profileActionErrorMessage('kick', { status: 400, code: 'target_is_owner' }).key).toBe('shell.profile.error.owner');
    expect(profileActionErrorMessage('ban', { status: 409, code: 'already_banned' }).key).toBe('shell.profile.error.alreadyBanned');
    expect(profileActionErrorMessage('roles', { status: 404, code: 'role_not_found' }).key).toBe('shell.profile.error.notFound');
    expect(profileActionErrorMessage('roles', { status: 403, code: 'role_above_actor' }).key).toBe('shell.profile.error.roleRank');
    expect(profileActionErrorMessage('roles', { status: 403, code: 'ungrantable_permissions' }).key).toBe('shell.profile.error.roleGrant');
  });

  it('every code it knows has an English and a Turkish sentence', () => {
    const en = enShell as Record<string, string>;
    const tr = trShell as Record<string, string>;
    for (const code of KNOWN_REFUSAL_CODES) {
      const { key } = profileActionErrorMessage('kick', { status: 400, code });
      expect(en[key], `${code} → ${key}`).toBeTruthy();
      expect(tr[key], `${code} → ${key}`).toBeTruthy();
    }
  });

  it('an unknown code falls back on the status, never on the server’s text', () => {
    expect(profileActionErrorMessage('kick', { status: 403, code: 'something_new' }).key).toBe('shell.profile.error.forbidden');
    expect(profileActionErrorMessage('kick', { status: 401 }).key).toBe('shell.profile.error.signIn');
  });

  it('a DM refusal never says why (blocked or not)', () => {
    expect(profileActionErrorMessage('message', { status: 403 }).key).toBe('shell.profile.error.cannotMessage');
    expect(profileActionErrorMessage('message', { status: 404 }).key).toBe('shell.profile.error.cannotMessage');
  });
});

// Security review 2026-10 (A1): every management route refuses a
// timed-out actor with `actor_timed_out`; the admin screens say it in the
// viewer's language instead of the route's English `error`.
describe('the timed-out refusal on the admin screens', () => {
  const body = { error: 'You are timed out in this server', code: 'actor_timed_out', until: '2026-10-15T12:00:00.000Z' };

  it('timedOutRefusalKey recognises only actor_timed_out', () => {
    expect(timedOutRefusalKey(body)).toBe('shell.profile.error.timedOut');
    expect(timedOutRefusalKey({ code: 'forbidden' })).toBeNull();
    expect(timedOutRefusalKey({ error: 'Forbidden' })).toBeNull();
    expect(timedOutRefusalKey(null)).toBeNull();
    expect(timedOutRefusalKey('actor_timed_out')).toBeNull();
  });

  it('adminRefusalText says it in English and Turkish, and keeps the old behaviour otherwise', () => {
    const en = translatorFor('en');
    const tr = translatorFor('tr');
    expect(adminRefusalText(en, body, 'fallback')).toBe("You're timed out in this community.");
    expect(adminRefusalText(tr, body, 'fallback')).toBe('Bu toplulukta zaman aşımındasın.');
    expect(adminRefusalText(en, { error: 'Role not found' }, 'fallback')).toBe('Role not found');
    expect(adminRefusalText(en, {}, 'fallback')).toBe('fallback');
    expect(adminRefusalText(en, { error: '' }, 'fallback')).toBe('fallback');
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
        inVoice: false,
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

  it('in voice: a live seed fact first, else the API; never while the API withholds presence', () => {
    expect(mergeProfileView({ ...seed, inVoice: undefined }, api({ inVoice: true })).inVoice).toBe(true);
    expect(mergeProfileView({ ...seed, inVoice: false }, api({ inVoice: true })).inVoice).toBe(false);
    expect(mergeProfileView(seed, api({ presence: null, inVoice: false })).inVoice).toBe(false);
    expect(mergeProfileView({ ...seed, inVoice: undefined }, null).inVoice).toBe(false);
  });

  it('presence: the live seed beats the API snapshot, unless the API withholds it; yours is what you picked', () => {
    expect(mergeProfileView(seed, api({ presence: 'online' })).presence).toBe('dnd');
    expect(mergeProfileView(seed, api({ presence: null })).presence).toBeNull();
    expect(mergeProfileView({ ...seed, presence: null }, api({ presence: 'idle' })).presence).toBe('idle');
    expect(mergeProfileView(seed, api({}), 'offline').presence).toBe('offline');
  });
});
