import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CorePermission } from '@lobbyforge/core';
import { ADMIN_SECTIONS, COMMUNITY_ADMIN_SECTIONS, type AdminSection } from '@/lib/admin-sections';

/**
 * The admin guard (lib/admin-access.ts): who may open which admin page,
 * and that everyone else gets a real 404 — signed out, guests, members,
 * moderators outside their section — while the owner opens everything.
 */

const NOT_FOUND = 'NEXT_NOT_FOUND';
const SECRET = 'x'.repeat(48);
const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';
const OWNER = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000002';

const state = vi.hoisted(() => ({
  instanceAdmin: false,
  session: null as { uid: string | null } | null,
  official: false,
  user: null as { isGuest: boolean } | null,
  servers: [] as Array<{ id: string; name: string; ownerUserId: string }>,
  permissions: [] as string[],
  server: null as { id: string; name: string; ownerUserId: string } | null,
  dbFails: false,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => 'lf_guest=signed', get: () => undefined }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/admin-auth', () => ({
  ADMIN_TOKEN_COOKIE: 'lf_admin_token',
  isInstanceAdminAllowed: vi.fn(async () => state.instanceAdmin),
}));
vi.mock('@/lib/active-session', () => ({
  getActiveSession: vi.fn(async () => state.session),
}));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => state.official }));
vi.mock('@/lib/i18n/server', () => ({ getTranslator: async () => (key: string) => `t:${key}` }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@lobbyforge/db', () => {
  const guard = <T>(value: () => T) => async () => {
    if (state.dbFails) throw new Error('db down');
    return value();
  };
  return {
    getUserById: vi.fn(guard(() => state.user)),
    getInstanceSetupStatus: vi.fn(guard(() => ({ ownerUserId: OWNER }))),
    listServersForUser: vi.fn(guard(() => state.servers)),
    getUserPermissions: vi.fn(guard(() => state.permissions)),
    getServerById: vi.fn(guard(() => state.server)),
  };
});

import {
  adminPageMetadata,
  adminSectionsForServer,
  allowedAdminSections,
  requireAdminArea,
  requireAdminSection,
  requireServerSettings,
  resolveAdminAccess,
  type AdminViewerFacts,
} from '@/lib/admin-access';

const EVERYONE = [
  CorePermission.SEND_MESSAGES,
  CorePermission.READ_MESSAGE_HISTORY,
  CorePermission.MENTION_EVERYONE,
  CorePermission.CONNECT_VOICE,
  CorePermission.SPEAK,
  CorePermission.STREAM,
  CorePermission.ADD_REACTIONS,
  CorePermission.CREATE_INVITE,
];

const facts = (overrides: Partial<AdminViewerFacts> = {}): AdminViewerFacts => ({
  instanceAdmin: false,
  guest: false,
  permissions: EVERYONE,
  official: false,
  ...overrides,
});

const INSTANCE_SECTIONS = ADMIN_SECTIONS.filter(
  (section) => !(COMMUNITY_ADMIN_SECTIONS as readonly AdminSection[]).includes(section)
);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  state.instanceAdmin = false;
  state.session = null;
  state.official = false;
  state.user = null;
  state.servers = [{ id: SERVER_ID, name: 'Community', ownerUserId: OWNER }];
  state.permissions = [];
  state.server = { id: SERVER_ID, name: 'Community', ownerUserId: OWNER };
  state.dbFails = false;
});

describe('the section → permission map', () => {
  it.each<[string, string[], AdminSection[]]>([
    ['a member (@everyone)', [], []],
    ['Kick Members', [CorePermission.KICK_MEMBERS], ['members']],
    ['Ban Members', [CorePermission.BAN_MEMBERS], ['members']],
    ['Manage Roles', [CorePermission.MANAGE_ROLES], ['members', 'roles']],
    ['Manage Channels', [CorePermission.MANAGE_CHANNELS], ['channels']],
    ['View Audit Log', [CorePermission.VIEW_AUDIT_LOG], ['audit']],
    ['Manage Community', [CorePermission.MANAGE_SERVER], ['members', 'invites', 'voiceMedia', 'apps', 'bots']],
    ['Mute Members (voice only)', [CorePermission.MUTE_MEMBERS], []],
    ['Manage Messages (chat only)', [CorePermission.MANAGE_MESSAGES], []],
    ['Timeout (no page offers it)', [CorePermission.MODERATE_MEMBERS], []],
    ['Administrator (not the owner)', [CorePermission.ADMINISTRATOR], [...COMMUNITY_ADMIN_SECTIONS]],
  ])('%s opens exactly its sections', (_label, extra, expected) => {
    expect(allowedAdminSections(facts({ permissions: [...EVERYONE, ...extra] }))).toEqual(expected);
  });

  it('gives no one but the instance admin an instance section', () => {
    const everything = allowedAdminSections(facts({ permissions: [CorePermission.ADMINISTRATOR] }));
    for (const section of INSTANCE_SECTIONS) expect(everything).not.toContain(section);
  });

  it('opens every section to the instance admin, in nav order', () => {
    expect(allowedAdminSections(facts({ instanceAdmin: true, permissions: [] }))).toEqual([...ADMIN_SECTIONS]);
  });

  it('never opens anything to a guest, whatever its roles say', () => {
    expect(allowedAdminSections(facts({ guest: true, permissions: [CorePermission.ADMINISTRATOR] }))).toEqual([]);
  });

  it('keeps /admin for the operator on the official hub', () => {
    expect(allowedAdminSections(facts({ official: true, permissions: [CorePermission.ADMINISTRATOR] }))).toEqual([]);
    expect(allowedAdminSections(facts({ official: true, instanceAdmin: true }))).toEqual([...ADMIN_SECTIONS]);
  });
});

describe('resolving a request', () => {
  const resolve = () => resolveAdminAccess({ cookieHeader: 'lf_guest=signed', adminToken: null, official: state.official });

  it('signed out: nothing, without touching the database', async () => {
    const { getUserById } = await import('@lobbyforge/db');
    const access = await resolve();
    expect(access.sections).toEqual([]);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('a revoked or expired session reads as signed out', async () => {
    state.session = null; // getActiveSession answers null for both
    expect((await resolve()).sections).toEqual([]);
  });

  it('a guest: nothing', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: true };
    state.permissions = [CorePermission.ADMINISTRATOR];
    const access = await resolve();
    expect(access.guest).toBe(true);
    expect(access.sections).toEqual([]);
  });

  it('a member: nothing', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = EVERYONE;
    expect((await resolve()).sections).toEqual([]);
  });

  it('a moderator with Kick Members: Members only, on their community', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = [...EVERYONE, CorePermission.KICK_MEMBERS];
    const access = await resolve();
    expect(access.sections).toEqual(['members']);
    expect(access.server?.id).toBe(SERVER_ID);
    expect(access.userId).toBe(VIEWER);
  });

  it('a banned or removed account holds no permissions: nothing', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = [];
    expect((await resolve()).sections).toEqual([]);
  });

  it('an account with no community: nothing', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.servers = [];
    state.permissions = [CorePermission.ADMINISTRATOR];
    expect((await resolve()).sections).toEqual([]);
  });

  it('the owner: everything', async () => {
    state.instanceAdmin = true;
    state.session = { uid: OWNER };
    state.permissions = [CorePermission.ADMINISTRATOR];
    const access = await resolve();
    expect(access.sections).toEqual([...ADMIN_SECTIONS]);
    expect(access.userId).toBe(OWNER);
  });

  it('the operator token without a session: everything, showing the owner’s community', async () => {
    state.instanceAdmin = true;
    const access = await resolve();
    expect(access.sections).toEqual([...ADMIN_SECTIONS]);
    expect(access.sessionUserId).toBeNull();
    expect(access.userId).toBe(OWNER);
  });

  it('fails closed when the database is down — except for the instance admin', async () => {
    state.session = { uid: VIEWER };
    state.dbFails = true;
    expect((await resolve()).sections).toEqual([]);
    state.instanceAdmin = true;
    expect((await resolve()).sections).toEqual([...ADMIN_SECTIONS]);
  });

  it('without a session secret nobody is signed in', async () => {
    delete process.env.LOBBYFORGE_SESSION_SECRET;
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = [CorePermission.ADMINISTRATOR];
    expect((await resolve()).sections).toEqual([]);
  });
});

describe('the page guard', () => {
  async function asModerator() {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = [...EVERYONE, CorePermission.KICK_MEMBERS];
  }

  it('lets a viewer into a section they hold', async () => {
    await asModerator();
    await expect(requireAdminSection('members')).resolves.toMatchObject({ sections: ['members'] });
  });

  it.each(ADMIN_SECTIONS.filter((section) => section !== 'members'))(
    'answers a moderator with Kick Members on %s with notFound()',
    async (section) => {
      await asModerator();
      await expect(requireAdminSection(section)).rejects.toThrow(NOT_FOUND);
    }
  );

  it.each([...ADMIN_SECTIONS])('answers a signed-out visitor on %s with notFound()', async (section) => {
    await expect(requireAdminSection(section)).rejects.toThrow(NOT_FOUND);
  });

  it('answers the admin area itself with notFound() for a member and a guest', async () => {
    state.session = { uid: VIEWER };
    state.user = { isGuest: false };
    state.permissions = EVERYONE;
    await expect(requireAdminArea()).rejects.toThrow(NOT_FOUND);
    state.user = { isGuest: true };
    await expect(requireAdminArea()).rejects.toThrow(NOT_FOUND);
  });

  it('guards the title too, so a refused page does not name itself', async () => {
    await asModerator();
    await expect(adminPageMetadata('roles', 'adminSettings.roles.metaTitle')).rejects.toThrow(NOT_FOUND);
    await expect(adminPageMetadata('members', 'adminSettings.members.metaTitle')).resolves.toEqual({
      title: 't:adminSettings.members.metaTitle',
    });
  });
});

describe('lobby sections for the community in view', () => {
  it('keeps community sections only for the community the pages manage', async () => {
    state.instanceAdmin = true;
    state.session = { uid: OWNER };
    const access = await resolveAdminAccess({ cookieHeader: '', adminToken: null, official: false });
    expect(adminSectionsForServer(access, SERVER_ID)).toEqual([...ADMIN_SECTIONS]);
    expect(adminSectionsForServer(access, '00000000-0000-4000-8000-0000000000bb')).toEqual(INSTANCE_SECTIONS);
    expect(adminSectionsForServer(access, null)).toEqual(INSTANCE_SECTIONS);
  });
});

describe('the community settings page guard (/servers/{id})', () => {
  function signedIn(permissions: string[], options: { guest?: boolean; uid?: string } = {}) {
    state.session = { uid: options.uid ?? VIEWER };
    state.user = { isGuest: options.guest ?? false };
    state.permissions = permissions;
  }

  it('lets in Manage Community and says what else the viewer may do', async () => {
    signedIn([...EVERYONE, CorePermission.MANAGE_SERVER]);
    await expect(requireServerSettings(SERVER_ID)).resolves.toEqual({
      userId: VIEWER,
      server: { id: SERVER_ID, name: 'Community', ownerUserId: OWNER },
      isOwner: false,
      can: { manageChannels: false, kickMembers: false, createInvite: true, viewAuditLog: false, manageRoles: false },
    });
  });

  it('gives the owner everything', async () => {
    signedIn([CorePermission.ADMINISTRATOR], { uid: OWNER });
    const access = await requireServerSettings(SERVER_ID);
    expect(access.isOwner).toBe(true);
    expect(access.can).toEqual({ manageChannels: true, kickMembers: true, createInvite: true, viewAuditLog: true, manageRoles: true });
  });

  it.each<[string, () => void]>([
    ['signed out', () => {}],
    ['a guest', () => signedIn([CorePermission.ADMINISTRATOR], { guest: true })],
    ['a member', () => signedIn(EVERYONE)],
    ['a moderator without Manage Community', () => signedIn([...EVERYONE, CorePermission.KICK_MEMBERS, CorePermission.MANAGE_CHANNELS])],
    ['someone who is not a member', () => signedIn([])],
  ])('answers %s with notFound()', async (_label, arrange) => {
    arrange();
    await expect(requireServerSettings(SERVER_ID)).rejects.toThrow(NOT_FOUND);
  });

  it('answers an unknown or malformed id with the same notFound()', async () => {
    signedIn([CorePermission.ADMINISTRATOR], { uid: OWNER });
    await expect(requireServerSettings('not-a-uuid')).rejects.toThrow(NOT_FOUND);
    state.server = null;
    await expect(requireServerSettings(SERVER_ID)).rejects.toThrow(NOT_FOUND);
  });

  it('fails closed when the database is down', async () => {
    signedIn([CorePermission.ADMINISTRATOR], { uid: OWNER });
    state.dbFails = true;
    await expect(requireServerSettings(SERVER_ID)).rejects.toThrow(NOT_FOUND);
  });
});
