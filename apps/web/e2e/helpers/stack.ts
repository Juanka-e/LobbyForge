/**
 * Shared set-up for the A-to-Z specs (roles-permissions-matrix,
 * voice-drop, activity-voice-drop): the owner's session on the compose
 * stack, members made through invites, a real-UI browser and the small
 * HTTP helpers every one of them repeats. Same conventions as the other
 * compose specs:
 *
 *  - the owner is `owner@e2e.local`: first-run setup on a fresh stack,
 *    a sign-in on a warm one;
 *  - every request carries `Origin` (the CSRF guard refuses a POST without
 *    it), and a real-UI browser is launched WITHOUT the Playwright config's
 *    `--disable-web-security`, which drops that header;
 *  - every context is the same client address, so the routes' rate limits
 *    are shared: a 429 is relieved by clearing the stack's `*rate-limit*`
 *    keys (helpers/auth.ts), or waited out.
 */
import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type BrowserType, type Page } from '@playwright/test';
import { createGuest, registerAccount, resetRateLimits, signIn } from './auth';

export const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
export const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
export const OWNER_EMAIL = 'owner@e2e.local';
export const OWNER_PASSWORD = 'compose-e2e-owner-pw';
export const ORIGIN = { Origin: baseUrl };

/** Fake microphone/camera, no permission prompt, and the Origin header kept. */
export const FAKE_MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export async function launchRealUi(playwright: { chromium: BrowserType }, extraArgs: string[] = []): Promise<Browser> {
  return playwright.chromium.launch({ args: [...FAKE_MEDIA_ARGS, ...extraArgs] });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send, and on a 429 clear the shared rate-limit keys (or wait out a
 * short Retry-After) and send again. Every context here is one address.
 */
export async function send(call: () => Promise<APIResponse>): Promise<APIResponse> {
  let res = await call();
  for (let attempt = 0; attempt < 3 && res.status() === 429; attempt += 1) {
    if (!resetRateLimits()) {
      const wait = Math.min(Number(res.headers()['retry-after'] ?? '30') || 30, 75);
      await sleep((wait + 1) * 1000);
    }
    res = await call();
  }
  return res;
}

export async function json<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  return (await res.json()) as T;
}

export interface Person {
  ctx: BrowserContext;
  api: APIRequestContext;
  uid: string;
  name: string;
  page?: Page;
}

/** The owner's context: first-run setup on a fresh stack, else a sign-in. */
export async function ownerContext(browser: Browser, contextOptions: Parameters<Browser['newContext']>[0] = {}): Promise<Person> {
  const ctx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', ...contextOptions });
  const setup = await ctx.request.post('/api/setup/complete', {
    headers: ORIGIN,
    data: {
      setupToken,
      instanceName: 'A-to-Z E2E',
      ownerDisplayName: 'Owner',
      ownerEmail: OWNER_EMAIL,
      ownerPassword: OWNER_PASSWORD,
      registrationMode: 'open',
      guestAccessEnabled: true,
      seoIndexingEnabled: false,
    },
  });
  if (setup.status() !== 200) {
    const login = await signIn(ctx.request, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    expect(login.status(), 'owner sign-in on a warm stack').toBe(200);
  }
  const me = await json<{ guest: { uid: string; name: string } }>(await ctx.request.get('/api/auth/guest'));
  return { ctx, api: ctx.request, uid: me.guest.uid, name: me.guest.name };
}

export async function firstServerId(api: APIRequestContext): Promise<string> {
  const { servers } = await json<{ servers: Array<{ id: string }> }>(await api.get('/api/servers'));
  expect(servers.length, 'the owner has a community').toBeGreaterThan(0);
  return servers[0]!.id;
}

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
}

export async function listChannels(api: APIRequestContext, serverId: string): Promise<ChannelRow[]> {
  const res = await send(() => api.get(`/api/servers/${serverId}/channels`));
  if (res.status() !== 200) return [];
  return (await json<{ channels: ChannelRow[] }>(res)).channels;
}

export async function createChannel(api: APIRequestContext, serverId: string, name: string, type: 'text' | 'voice'): Promise<string> {
  const res = await send(() => api.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name, type } }));
  expect(res.status(), `create #${name}: ${await res.text()}`).toBe(201);
  return (await json<{ channel: { id: string } }>(res)).channel.id;
}

export async function deleteChannel(api: APIRequestContext, serverId: string, channelId: string): Promise<void> {
  await send(() => api.delete(`/api/servers/${serverId}/channels/${channelId}`, { headers: ORIGIN })).catch(() => undefined);
}

export async function newInviteCode(api: APIRequestContext, serverId: string): Promise<string> {
  const res = await send(() => api.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} }));
  expect(res.status(), `invite: ${await res.text()}`).toBe(201);
  return (await json<{ invite: { code: string } }>(res)).invite.code;
}

export async function redeem(api: APIRequestContext, code: string): Promise<APIResponse> {
  return send(() => api.post(`/api/invites/${code}/redeem`, { headers: ORIGIN }));
}

/** A new guest (its own context) who joined through a fresh invite. */
export async function guestMember(
  browser: Browser,
  owner: APIRequestContext,
  serverId: string,
  seed: string,
  contextOptions: Parameters<Browser['newContext']>[0] = {}
): Promise<Person> {
  const ctx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', ...contextOptions });
  const created = await send(() => createGuest(ctx.request, { headers: ORIGIN, data: { displayNameSeed: seed } }));
  expect(created.status(), `guest ${seed}`).toBe(200);
  const code = await newInviteCode(owner, serverId);
  expect((await redeem(ctx.request, code)).status(), `${seed} redeems the invite`).toBe(201);
  const me = await json<{ guest: { uid: string; name: string } }>(await ctx.request.get('/api/auth/guest'));
  return { ctx, api: ctx.request, uid: me.guest.uid, name: me.guest.name };
}

/** A registered account (admin pages are never shown to guests) who joined through an invite. */
export async function accountMember(
  browser: Browser,
  owner: APIRequestContext,
  serverId: string,
  displayName: string,
  contextOptions: Parameters<Browser['newContext']>[0] = {}
): Promise<Person & { email: string; password: string }> {
  const ctx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', ...contextOptions });
  const email = `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${Date.now().toString(36)}@e2e.local`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const code = await newInviteCode(owner, serverId);
  const res = await registerAccount(ctx.request, { headers: ORIGIN, data: { email, password, displayName, inviteCode: code } });
  expect(res.status(), `register ${displayName}: ${await res.text()}`).toBe(201);
  // The invite may already have made the membership at sign-up; redeeming again is harmless.
  const again = await redeem(ctx.request, code);
  expect([200, 201, 409]).toContain(again.status());
  const me = await json<{ guest: { uid: string; name: string } }>(await ctx.request.get('/api/auth/guest'));
  return { ctx, api: ctx.request, uid: me.guest.uid, name: me.guest.name, email, password };
}

export interface RoleRow {
  id: string;
  name: string;
  position: number;
  permissions: string[];
}

export async function listRoles(api: APIRequestContext, serverId: string): Promise<RoleRow[]> {
  return (await json<{ roles: RoleRow[] }>(await send(() => api.get(`/api/servers/${serverId}/roles`)))).roles;
}

export async function everyoneRole(api: APIRequestContext, serverId: string): Promise<RoleRow> {
  return (await listRoles(api, serverId)).filter((r) => r.name === '@everyone').sort((a, b) => a.position - b.position)[0]!;
}

export async function createRole(
  api: APIRequestContext,
  serverId: string,
  data: { name: string; permissions: string[]; position?: number }
): Promise<RoleRow> {
  const res = await send(() => api.post(`/api/servers/${serverId}/roles`, { headers: ORIGIN, data }));
  expect(res.status(), `create role ${data.name}: ${await res.text()}`).toBe(201);
  return (await json<{ role: RoleRow }>(res)).role;
}

export async function setRoles(api: APIRequestContext, serverId: string, userId: string, roleIds: string[]): Promise<APIResponse> {
  return send(() => api.put(`/api/servers/${serverId}/members/${userId}/role`, { headers: ORIGIN, data: { roleIds } }));
}

/** A channel holds one activity at a time: end what a previous run left behind. */
export async function endOpenActivities(api: APIRequestContext, serverId: string, channelId: string): Promise<void> {
  const res = await api.get(`/api/servers/${serverId}/channels/${channelId}/activities`);
  if (!res.ok()) return;
  const { activities } = await json<{ activities?: Array<{ id: string; status: string }> }>(res);
  for (const open of (activities ?? []).filter((a) => a.status !== 'ended' && a.status !== 'cancelled')) {
    await api.post(`/api/servers/${serverId}/activities/${open.id}/end`, { headers: ORIGIN, data: {} });
  }
}

/** Decode a LiveKit token's payload (no signature check: the server issued it). */
export function decodeJwt(token: string): Record<string, any> {
  const part = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Screenshot in dark, then light, then back to dark. */
export async function shootBothThemes(page: Page, path: (theme: 'dark' | 'light') => string): Promise<void> {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path(colorScheme) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

/** Where the lead asked for the key screenshots; falls back to the test output folder. */
export const SHOT_DIR = process.env.LF_E2E_SHOT_DIR ?? '';

/** Run one redis-cli command in the stack's Redis (test data only). Null when Docker is out of reach. */
export function redisCli(args: string[]): string | null {
  const container = process.env.LF_E2E_REDIS_CONTAINER ?? 'lobbyforge-e2e-redis';
  const password = process.env.LF_E2E_REDIS_PASSWORD ?? 'lobbyforge_dev';
  try {
    return execFileSync('docker', ['exec', container, 'redis-cli', '-a', password, '--no-auth-warning', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).toString('utf8');
  } catch {
    return null;
  }
}

/** Run SQL in the stack's Postgres (test data only). Null when Docker is out of reach. */
export function psql(sql: string): string | null {
  const container = process.env.LF_E2E_POSTGRES_CONTAINER ?? 'lobbyforge-e2e-postgres';
  try {
    return execFileSync('docker', ['exec', container, 'psql', '-U', 'lobbyforge', '-d', 'lobbyforge', '-tAc', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).toString('utf8');
  } catch {
    return null;
  }
}
