/**
 * Account security on the real stack (docs/GUEST_AUTH.md, docs/CAPTCHA.md):
 *
 *   - a password change keeps the current session and signs every other
 *     session out; the old password stops working;
 *   - ten wrong passwords lock the account (429 even for the right one),
 *     but the owner's own browser — a valid `lf_device` cookie — still
 *     signs in;
 *   - the 30-day absolute session lifetime: a session whose `auth_time` is
 *     31 days old is signed out even though its `exp` is still valid, and
 *     the guest route does not refresh it (needs LOBBYFORGE_SESSION_SECRET,
 *     the stack's session secret, to forge the cookies);
 *   - active sessions: another session can be revoked, the current one not;
 *   - desktop handoff: a code completes once; after three failed attempts
 *     the desktop sign-in needs the login challenge too.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Every request comes
 * from one client address: the spec clears the sign-in bucket between
 * attempts (never the per-account counters it is testing).
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { buildGuestSessionCookie } from '@lobbyforge/core';
import { captchaFields, clearRateLimitBuckets, registerAccount, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const sessionSecret = process.env.LOBBYFORGE_SESSION_SECRET ?? '';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PASSWORD = 'correct-horse-battery-staple';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'default', timeout: 120_000 });

const freshSignIns = () => clearRateLimitBuckets(['auth-local-login']);

test.describe('account security', () => {
  let request: PlaywrightWorkerArgs['playwright']['request'];
  const contexts: APIRequestContext[] = [];
  async function api(): Promise<APIRequestContext> {
    const ctx = await request.newContext({ baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } });
    contexts.push(ctx);
    return ctx;
  }
  async function account(seed: string): Promise<string> {
    const email = `acct-${seed}-${RUN}@e2e.local`;
    const res = await registerAccount(await api(), { data: { email, password: PASSWORD, displayName: `Acct ${seed} ${RUN.slice(-4)}` } });
    expect(res.status(), await res.text()).toBe(201);
    return email;
  }

  test.beforeAll(async ({ playwright }) => {
    request = playwright.request;
    resetRateLimits();
  });

  test.afterAll(async () => {
    for (const ctx of contexts) await ctx.dispose();
  });

  test('a password change signs every other session out and retires the old password', async () => {
    const email = await account('pw');
    const a = await api();
    const b = await api();
    freshSignIns();
    expect((await signIn(a, { data: { email, password: PASSWORD } })).status()).toBe(200);
    expect((await signIn(b, { data: { email, password: PASSWORD } })).status()).toBe(200);
    const change = await a.post('/api/auth/password', { data: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` } });
    expect(change.status()).toBe(200);
    expect(await change.json()).toEqual({ status: 'changed' });
    expect((await a.get('/api/servers')).status()).toBe(200);
    expect((await b.get('/api/servers')).status()).toBe(401);
    freshSignIns();
    expect((await signIn(await api(), { data: { email, password: PASSWORD } })).status()).toBe(401);
    expect((await signIn(await api(), { data: { email, password: `${PASSWORD}-2` } })).status()).toBe(200);
  });

  test('ten wrong passwords lock the account; the owner\'s browser (device cookie) still signs in', async () => {
    const email = await account('lock');
    const device = await api();
    freshSignIns();
    expect((await signIn(device, { data: { email, password: PASSWORD } })).status()).toBe(200);
    const cookie = (await device.storageState()).cookies.find((c) => c.name === 'lf_device');
    expect(cookie?.httpOnly).toBe(true);
    await device.post('/api/auth/logout');

    const attacker = await api();
    for (let i = 1; i <= 10; i += 1) {
      freshSignIns();
      // After 3 failures the adaptive challenge is asked for; signIn solves it.
      expect((await signIn(attacker, { data: { email, password: `wrong-${i}` } })).status(), `wrong password #${i}`).toBe(401);
    }
    freshSignIns();
    expect((await signIn(attacker, { data: { email, password: PASSWORD } })).status(), 'locked for a new browser').toBe(429);
    freshSignIns();
    expect((await device.post('/api/auth/login', { data: { email, password: PASSWORD } })).status(), 'the device cookie bypasses the lock').toBe(200);
  });

  test('a session older than 30 days (auth_time) is signed out and never refreshed', async () => {
    test.skip(!sessionSecret, 'Set LOBBYFORGE_SESSION_SECRET (the stack\'s session secret) to forge the cookies.');
    const email = await account('age');
    const ctx = await api();
    freshSignIns();
    expect((await signIn(ctx, { data: { email, password: PASSWORD } })).status()).toBe(200);
    const me = ((await (await ctx.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } }).guest;
    const now = Math.floor(Date.now() / 1000);
    const forge = (authTime: number, maxAgeSeconds?: number) =>
      buildGuestSessionCookie({ gid: `g_${randomBytes(16).toString('hex')}`, uid: me.uid, name: me.name }, sessionSecret, {
        authTime,
        now,
        secure: false,
        ...(maxAgeSeconds ? { maxAgeSeconds } : {}),
      });
    // exp still valid (a long max age), auth_time 31 days ago.
    const old = forge(now - 31 * 86_400, 365 * 86_400);
    const young = forge(now - 29 * 86_400);
    const send = (cookie: { raw: string }, path: string, init: RequestInit = {}) =>
      fetch(new URL(path, baseUrl), { redirect: 'manual', ...init, headers: { cookie: `lf_guest=${cookie.raw}`, Origin: baseUrl, 'content-type': 'application/json' } });
    expect((await send(old, '/api/auth/guest')).status).toBe(401);
    const lobby = await send(old, '/lobby');
    expect(lobby.status).toBe(307);
    expect(new URL(lobby.headers.get('location') ?? '', baseUrl).pathname).toBe('/login');
    expect((await send(young, '/api/auth/guest')).status).toBe(200);
    const refresh = await send(old, '/api/auth/guest', { method: 'POST', body: '{}' });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe('captcha_required');
  });

  test('active sessions: another session is revoked; the current one cannot be', async () => {
    const email = await account('sess');
    const s1 = await api();
    const s2 = await api();
    freshSignIns();
    await signIn(s1, { data: { email, password: PASSWORD } });
    await signIn(s2, { data: { email, password: PASSWORD } });
    const gid = async (ctx: APIRequestContext) => ((await (await ctx.get('/api/auth/guest')).json()) as { guest: { gid: string } }).guest.gid;
    const otherGid = await gid(s2);
    expect(JSON.stringify(await (await s1.get('/api/settings/me/sessions')).json())).toContain(otherGid);
    expect((await s1.patch('/api/settings/me/sessions', { data: { action: 'revoke', gid: otherGid } })).status()).toBe(200);
    expect((await s2.get('/api/servers')).status()).toBe(401);
    expect((await s1.patch('/api/settings/me/sessions', { data: { action: 'revoke', gid: await gid(s1) } })).status()).toBe(409);
  });

  test('desktop handoff: a code completes once; after three failures it needs the login challenge', async () => {
    const email = await account('desk');
    const shell = await api();
    freshSignIns();
    const mint = await shell.post('/api/auth/desktop-session', { data: { email, password: PASSWORD } });
    expect(mint.status()).toBe(200);
    const code = (await mint.json()) as { code: string; state: string };
    const done = await (await api()).post('/api/auth/desktop-session/complete', { data: code });
    expect(done.status()).toBe(200);
    expect(done.headers()['set-cookie'] ?? '').toContain('lf_guest=');
    expect((await (await api()).post('/api/auth/desktop-session/complete', { data: code })).status()).toBe(401);

    const desk = await api();
    for (let i = 1; i <= 3; i += 1) {
      freshSignIns();
      expect((await desk.post('/api/auth/desktop-session', { data: { email, password: `wrong-${i}` } })).status()).toBe(401);
    }
    freshSignIns();
    const needs = await desk.post('/api/auth/desktop-session', { data: { email, password: PASSWORD } });
    expect(needs.status()).toBe(400);
    expect(((await needs.json()) as { error: string }).error).toBe('captcha_required');
    const solved = await desk.post('/api/auth/desktop-session', { data: { email, password: PASSWORD, ...(await captchaFields(desk, 'login', { force: true })) } });
    expect(solved.status()).toBe(200);
  });
});
