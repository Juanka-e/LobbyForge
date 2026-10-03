import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

/**
 * security-review AUTH-001 — the whole attack, end to end across the three
 * routes against one in-memory Redis: an attacker who knows the old
 * password keeps a desktop handoff code in hand, the victim changes the
 * password, the attacker completes the handoff. It must fail.
 */

const { store, sets } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sets: new Map<string, Set<string>>(),
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    expire: vi.fn(async () => 1),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key) || sets.delete(key)) removed += 1;
      }
      return removed;
    }),
  },
}));

const { account, USER_ID } = vi.hoisted(() => ({
  account: { passwordHash: 'hash:old password' },
  USER_ID: '00000000-0000-0000-0000-000000000001',
}));

vi.mock('@lobbyforge/db', () => {
  const row = () => ({
    id: USER_ID,
    email: 'owner@example.test',
    displayName: 'Owner',
    passwordHash: account.passwordHash,
    isGuest: false,
    deletedAt: null,
  });
  return {
    getUserCredentialsByEmail: vi.fn(async () => row()),
    getUserCredentialsById: vi.fn(async () => row()),
    replaceUserPasswordHash: vi.fn(
      async (_db: unknown, input: { currentPasswordHash: string; newPasswordHash: string }) => {
        if (input.currentPasswordHash !== account.passwordHash) return false;
        account.passwordHash = input.newPasswordHash;
        return true;
      }
    ),
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/password', () => ({
  DUMMY_PASSWORD_HASH: 'hash:dummy',
  verifyPassword: vi.fn(async (password: string, hash: string) => hash === `hash:${password}`),
  hashPassword: vi.fn(async (password: string) => `hash:${password}`),
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({
  recordSession: vi.fn(async () => undefined),
  revokeOtherSessions: vi.fn(async () => 0),
}));

const SECRET = 'x'.repeat(32);

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  store.clear();
  sets.clear();
  account.passwordHash = 'hash:old password';
});

async function mint(password: string): Promise<{ code: string; state: string }> {
  const { POST } = await import('../route.js');
  const res = await POST(
    new Request('http://localhost/api/auth/desktop-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    }),
    {}
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; state: string };
}

async function changePassword(currentPassword: string, newPassword: string): Promise<Response> {
  const { POST } = await import('../../password/route.js');
  const cookie = buildGuestSessionCookie(
    { gid: `g_${'v'.repeat(32)}`, uid: USER_ID, name: 'Owner' },
    SECRET
  ).setCookieHeader.split(';', 1)[0];
  return POST(
    new Request('http://localhost/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
    {}
  );
}

async function completeHandoff(handoff: { code: string; state: string }): Promise<Response> {
  const { POST } = await import('../complete/route.js');
  return POST(
    new Request('http://localhost/api/auth/desktop-session/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(handoff),
    }),
    {}
  );
}

describe('security-review AUTH-001: desktop handoff vs password change', () => {
  it('mint → complete still signs in', async () => {
    const handoff = await mint('old password');
    const res = await completeHandoff(handoff);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('lf_guest=');
  });

  it('mint → change password → complete is 401', async () => {
    const handoff = await mint('old password');
    const changed = await changePassword('old password', 'brand new password');
    expect(changed.status).toBe(200);
    const res = await completeHandoff(handoff);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('the password route deletes every outstanding code of the user', async () => {
    const first = await mint('old password');
    const second = await mint('old password');
    expect(store.has(`lf:desktop-handoff:${first.code}`)).toBe(true);
    expect(store.has(`lf:desktop-handoff:${second.code}`)).toBe(true);

    const changed = await changePassword('old password', 'brand new password');
    expect(changed.status).toBe(200);
    expect(store.has(`lf:desktop-handoff:${first.code}`)).toBe(false);
    expect(store.has(`lf:desktop-handoff:${second.code}`)).toBe(false);
    expect(sets.has(`lf:desktop-handoff:user:${USER_ID}`)).toBe(false);
  });

  it('the fingerprint alone voids a code even when deleting it failed', async () => {
    const handoff = await mint('old password');
    // Simulate the index losing the code (e.g. a failed best-effort delete).
    sets.clear();
    const changed = await changePassword('old password', 'brand new password');
    expect(changed.status).toBe(200);
    expect(store.has(`lf:desktop-handoff:${handoff.code}`)).toBe(true);
    const res = await completeHandoff(handoff);
    expect(res.status).toBe(401);
  });

  it('a code minted under the new password works after the change', async () => {
    await changePassword('old password', 'brand new password');
    const handoff = await mint('brand new password');
    const res = await completeHandoff(handoff);
    expect(res.status).toBe(200);
  });
});
