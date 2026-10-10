import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * The community's app list (server settings, the old room picker) names
 * each app the way the lobby does: the plugin's own `catalog.name` in the
 * viewer's language, the manifest name otherwise.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  listPluginInstallsForServer: vi.fn(),
  getPluginInstall: vi.fn(),
  upsertPluginInstall: vi.fn(),
  deletePluginInstall: vi.fn(),
  logAction: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '33333333-3333-4333-8333-333333333333';

function sessionCookie(): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: MEMBER, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function names(headers: Record<string, string>): Promise<Record<string, string>> {
  const route = await import('../route.js');
  const res = await route.GET(
    new Request(`https://chat.example.test/api/servers/${SERVER}/apps`, {
      headers: {
        cookie: [sessionCookie(), headers.cookie].filter(Boolean).join('; '),
        ...(headers.lang ? { 'accept-language': headers.lang } : {}),
      },
    }),
    { params: Promise.resolve({ id: SERVER }) }
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { apps: Array<{ id: string; name: string }> };
  return Object.fromEntries(body.apps.map((app) => [app.id, app.name]));
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  delete process.env.LOBBYFORGE_DEFAULT_LOCALE;
  for (const fn of Object.values(db)) fn.mockReset();
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: 'someone-else' });
  db.isServerMember.mockResolvedValue(true);
  db.listPluginInstallsForServer.mockResolvedValue([]);
});

describe('GET /api/servers/{id}/apps — app names', () => {
  it('follows the viewer’s language choice', async () => {
    const tr = await names({ cookie: 'lf_locale=tr' });
    expect(tr.poll).toBe('Anket');
    expect(tr['vampire-village']).toBe('Vampir Köylü');
    expect(tr['dice-bot']).toBe('Zar');
    // Established names stay as they are.
    expect(tr.quiz).toBe('Quiz');
    expect(tr.hushle).toBe('Hushle');
  });

  it('falls back to the browser language, then English', async () => {
    expect((await names({ lang: 'tr-TR,tr;q=0.9' })).poll).toBe('Anket');
    expect((await names({ lang: 'de-DE' })).poll).toBe('Poll');
  });
});
