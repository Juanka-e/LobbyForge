import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CorePermission } from '@lobbyforge/core';
import { adminSectionForPath, type AdminSection } from '@/lib/admin-sections';

/**
 * Route-level: every real page under `app/admin/**` — and its title —
 * called as each kind of viewer. Refused viewers get Next's `notFound()`
 * and nothing else: the guard throws before the page reads any data (the
 * database here throws on first touch, so a page that loaded something
 * first would fail with DATA_ACCESS instead). Permitted viewers get past
 * the guard.
 */

const NOT_FOUND = 'NEXT_NOT_FOUND';
const DATA_ACCESS = 'DATA_ACCESS';
const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';
const OWNER = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000002';

const viewer = vi.hoisted(() => ({
  instanceAdmin: false,
  uid: null as string | null,
  guest: false,
  permissions: [] as string[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => '', get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/admin-auth', () => ({
  ADMIN_TOKEN_COOKIE: 'lf_admin_token',
  isInstanceAdminAllowed: async () => viewer.instanceAdmin,
}));
vi.mock('@/lib/active-session', () => ({
  getActiveSession: async () => (viewer.uid ? { uid: viewer.uid, gid: 'g', name: 'n', iat: 0, exp: 0 } : null),
  isSessionActive: async () => true,
}));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => false, getDeploymentMode: () => 'self_host' }));
// Any real query that runs touches this and fails loudly.
vi.mock('@/lib/db', () => ({
  getDb: () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error('DATA_ACCESS');
        },
      }
    ),
}));
// Pages that read beyond the database: fail the same way when reached.
vi.mock('@/lib/doctor', () => ({
  collectDoctorReport: async () => {
    throw new Error('DATA_ACCESS');
  },
}));
vi.mock('@/lib/update-planner', () => ({
  loadReleaseManifest: async () => {
    throw new Error('DATA_ACCESS');
  },
  buildUpdatePlan: () => {
    throw new Error('DATA_ACCESS');
  },
}));
vi.mock('@/lib/backup-verifier', () => ({
  loadBackupManifest: async () => {
    throw new Error('DATA_ACCESS');
  },
  verifyBackupManifest: () => {
    throw new Error('DATA_ACCESS');
  },
}));
vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobbyforge/db')>()),
  // What the guard reads — answered from `viewer`; everything else is real.
  getUserById: async (_db: unknown, id: string) => (id === viewer.uid ? { id, isGuest: viewer.guest } : null),
  getInstanceSetupStatus: async () => ({ ownerUserId: OWNER }),
  listServersForUser: async () => [{ id: SERVER_ID, name: 'Community', ownerUserId: OWNER }],
  getUserPermissions: async () => viewer.permissions,
}));

const APP_DIR = join(__dirname, '..', '..', 'app');

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') out.push(...pageFiles(full));
    } else if (entry === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

const PAGES = pageFiles(join(APP_DIR, 'admin')).map((file) => {
  const parts = relative(APP_DIR, file).split(sep).slice(0, -1);
  const url = `/${parts.map((part) => (part.startsWith('[') ? 'sample' : part)).join('/')}`;
  return { file, url, section: adminSectionForPath(url) as AdminSection };
});

const EVERYONE = [CorePermission.SEND_MESSAGES, CorePermission.CONNECT_VOICE, CorePermission.CREATE_INVITE];

type Profile = { name: string; set: () => void; opens: readonly AdminSection[] };

const PROFILES: Profile[] = [
  { name: 'signed out', set: () => {}, opens: [] },
  {
    name: 'a guest',
    set: () => Object.assign(viewer, { uid: VIEWER, guest: true, permissions: [CorePermission.ADMINISTRATOR] }),
    opens: [],
  },
  { name: 'a member', set: () => Object.assign(viewer, { uid: VIEWER, permissions: EVERYONE }), opens: [] },
  {
    name: 'a moderator with Kick Members',
    set: () => Object.assign(viewer, { uid: VIEWER, permissions: [...EVERYONE, CorePermission.KICK_MEMBERS] }),
    opens: ['members'],
  },
  {
    name: 'a channel manager',
    set: () => Object.assign(viewer, { uid: VIEWER, permissions: [...EVERYONE, CorePermission.MANAGE_CHANNELS] }),
    opens: ['channels'],
  },
  {
    name: 'an auditor',
    set: () => Object.assign(viewer, { uid: VIEWER, permissions: [...EVERYONE, CorePermission.VIEW_AUDIT_LOG] }),
    opens: ['audit'],
  },
  {
    name: 'a Manage Community holder',
    set: () => Object.assign(viewer, { uid: VIEWER, permissions: [...EVERYONE, CorePermission.MANAGE_SERVER] }),
    opens: ['members', 'invites', 'voiceMedia', 'apps', 'bots'],
  },
  {
    name: 'the owner',
    set: () => Object.assign(viewer, { uid: OWNER, instanceAdmin: true, permissions: [CorePermission.ADMINISTRATOR] }),
    opens: PAGES.map((page) => page.section),
  },
];

type PageModule = {
  default: (props: { params: Promise<Record<string, string>> }) => unknown;
  generateMetadata?: () => Promise<unknown>;
};

async function outcome(run: () => unknown): Promise<'notFound' | 'rendered'> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    const message = (error as Error).message;
    if (message === NOT_FOUND) return 'notFound';
    // Past the guard: the page went on to read its data.
    if (message === DATA_ACCESS || message.includes(DATA_ACCESS)) return 'rendered';
    throw error;
  }
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(48);
  Object.assign(viewer, { instanceAdmin: false, uid: null, guest: false, permissions: [] });
});

describe.each(PROFILES.map((profile) => [profile.name, profile] as const))('as %s', (_name, profile) => {
  it.each(PAGES.map((page) => [page.url, page] as const))('%s', async (_url, page) => {
    profile.set();
    const mod = (await import(/* @vite-ignore */ page.file)) as PageModule;
    const expected = profile.opens.includes(page.section) ? 'rendered' : 'notFound';
    const props = { params: Promise.resolve({ runId: 'sample' }) };
    expect(await outcome(() => mod.default(props))).toBe(expected);
    expect(mod.generateMetadata, 'generateMetadata').toBeTypeOf('function');
    expect(await outcome(() => mod.generateMetadata!())).toBe(expected);
  }, 30_000);
});
