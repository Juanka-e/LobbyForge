/**
 * Roles and permissions, as a matrix — every permission's effect checked
 * allowed AND refused against the real stack (docs/ROLES.md,
 * lib/member-authorization.ts, lib/role-grant-policy.ts,
 * lib/audit-log-view.ts, lib/bots/admin.ts).
 *
 * The people (every one a member of the stack's community):
 *
 *   owner     the instance owner (holds everything)
 *   admin     a registered account with a role carrying `administrator`
 *   mod       a registered account: Manage Messages, Kick, Ban, Moderate,
 *             Mute Members, Manage Roles, View Audit Log, Create Polls
 *   helper    a guest with Kick Members, ranked BELOW mod
 *   mod2      a guest with the same Mod role (equal rank)
 *   botmgr    a guest with Manage Community only (manages bots)
 *   chanmgr   a guest with Manage Channels only
 *   member    a registered account with only @everyone
 *   fresh     a guest who just joined (only @everyone)
 *   nohist    a guest with ONLY a role of Send Messages + Connect Voice
 *             (no history, no mention, no speak, no stream)
 *   novoice   a guest with ONLY Send Messages + Read History
 *   victims   throw-away guests for kick / ban / timeout / mute
 *
 * Mostly API-level — the way an attacker would come at it — plus the UI
 * entry points (community menu, admin pages, channel settings gear, the
 * voice roster's member menu) in real browser contexts.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Everything it
 * creates carries a run suffix and is removed at the end; the routes'
 * rate limits are relieved by clearing the stack's `*rate-limit*` keys.
 */
import { join } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { createGuest, registerAccount, resetRateLimits } from './helpers/auth';
import {
  baseUrl,
  decodeJwt,
  everyoneRole,
  firstServerId,
  json,
  launchRealUi,
  newInviteCode,
  ORIGIN,
  ownerContext,
  psql,
  redeem,
  send,
  SHOT_DIR,
  shootBothThemes,
  type Person,
  type RoleRow,
} from './helpers/stack';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

/** An observation for the report: kept as an annotation and printed by the list reporter. */
function note(testInfo: { annotations: Array<{ type: string; description?: string }> }, entry: { type: string; description: string }) {
  testInfo.annotations.push(entry);
  console.info(`[note] ${entry.type}: ${entry.description}`);
}
// In order, one worker; a failure does not skip the checks after it.
test.describe.configure({ mode: 'default', timeout: 180_000 });

type Playwright = PlaywrightWorkerArgs['playwright'];
const RUN = Date.now().toString(36).slice(-5);

interface Actor {
  api: APIRequestContext;
  uid: string;
  name: string;
  /** Registered accounts only: what a browser context needs to sign in as them. */
  storage?: Awaited<ReturnType<APIRequestContext['storageState']>>;
}

// ── Shared state ───────────────────────────────────────────────────────

let pw: Playwright;
let browser: Browser;
let ownerPerson: Person;
let owner: APIRequestContext;
let serverId = '';
let everyoneId = '';
const roles: Record<string, RoleRow> = {};
const people: Record<string, Actor> = {};
const channels: Record<string, string> = {};
const createdRoleIds: string[] = [];
const createdChannelIds: string[] = [];
const createdBotIds: string[] = [];
const extraContexts: APIRequestContext[] = [];

const api = (name: string) => people[name]!.api;
const uid = (name: string) => people[name]!.uid;

async function apiContext(): Promise<APIRequestContext> {
  const ctx = await pw.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
  extraContexts.push(ctx);
  return ctx;
}

async function guest(seed: string): Promise<Actor> {
  const ctx = await apiContext();
  const res = await send(() => createGuest(ctx, { data: { displayNameSeed: `${seed} ${RUN}` } }));
  expect(res.status(), `guest ${seed}`).toBe(200);
  const code = await newInviteCode(owner, serverId);
  expect((await redeem(ctx, code)).status(), `${seed} joins`).toBe(201);
  const me = await json<{ guest: { uid: string; name: string } }>(await ctx.get('/api/auth/guest'));
  return { api: ctx, uid: me.guest.uid, name: me.guest.name };
}

async function account(displayName: string): Promise<Actor> {
  const ctx = await apiContext();
  const email = `${displayName.toLowerCase()}.${RUN}.${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const code = await newInviteCode(owner, serverId);
  const res = await registerAccount(ctx, {
    data: { email, password: `matrix-${RUN}-correct-horse`, displayName: `${displayName} ${RUN}`, inviteCode: code },
  });
  expect(res.status(), `register ${displayName}: ${await res.text()}`).toBe(201);
  const again = await redeem(ctx, code);
  expect([200, 201, 409], `${displayName} membership`).toContain(again.status());
  const me = await json<{ guest: { uid: string; name: string } }>(await ctx.get('/api/auth/guest'));
  return { api: ctx, uid: me.guest.uid, name: me.guest.name, storage: await ctx.storageState() };
}

async function makeRole(key: string, permissions: string[], position: number): Promise<RoleRow> {
  const res = await send(() =>
    owner.post(`/api/servers/${serverId}/roles`, { data: { name: `mx-${key}-${RUN}`, permissions, position } })
  );
  expect(res.status(), `role ${key}: ${await res.text()}`).toBe(201);
  const role = (await json<{ role: RoleRow }>(res)).role;
  createdRoleIds.push(role.id);
  roles[key] = role;
  return role;
}

/** Positions shift as roles are inserted: read them back. */
async function refreshRoles(): Promise<void> {
  const { roles: all } = await json<{ roles: RoleRow[] }>(await send(() => owner.get(`/api/servers/${serverId}/roles`)));
  for (const [key, role] of Object.entries(roles)) {
    const fresh = all.find((r) => r.id === role.id);
    if (fresh) roles[key] = fresh;
  }
}

async function assign(name: string, roleKeys: string[], { withEveryone = true } = {}): Promise<void> {
  const ids = [...(withEveryone ? [everyoneId] : []), ...roleKeys.map((k) => roles[k]!.id)];
  const res = await send(() => owner.put(`/api/servers/${serverId}/members/${uid(name)}/role`, { data: { roleIds: ids } }));
  expect(res.status(), `assign ${roleKeys.join('+')} to ${name}: ${await res.text()}`).toBe(200);
}

async function makeChannel(key: string, type: 'text' | 'voice', gatedTo: string[] = []): Promise<string> {
  const res = await send(() => owner.post(`/api/servers/${serverId}/channels`, { data: { name: `mxc-${key}-${RUN}`, type } }));
  expect(res.status(), `channel ${key}: ${await res.text()}`).toBe(201);
  const id = (await json<{ channel: { id: string } }>(res)).channel.id;
  createdChannelIds.push(id);
  channels[key] = id;
  if (gatedTo.length > 0) {
    const gate = await send(() =>
      owner.patch(`/api/servers/${serverId}/channels/${id}`, { data: { visibleToRoleIds: gatedTo.map((k) => roles[k]!.id) } })
    );
    expect(gate.status(), `gate ${key}`).toBe(200);
  }
  return id;
}

async function channelIdsOf(name: string): Promise<string[]> {
  const res = await send(() => api(name).get(`/api/servers/${serverId}/channels`));
  expect(res.status()).toBe(200);
  return (await json<{ channels: Array<{ id: string }> }>(res)).channels.map((c) => c.id);
}

async function post(name: string, channelKey: string, content: string): Promise<APIResponse> {
  return send(() => api(name).post(`/api/servers/${serverId}/channels/${channels[channelKey]}/messages`, { data: { content } }));
}

async function code(res: APIResponse): Promise<string | undefined> {
  try {
    return ((await res.json()) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

async function voiceToken(name: string, channelKey: string): Promise<APIResponse> {
  return send(() => api(name).post('/api/livekit/token', { data: { serverId, channelId: channels[channelKey] } }));
}

/** LiveKit's `video.canPublishSources`, normalised to lower case. */
async function publishSources(res: APIResponse): Promise<{ sources: string[]; canPublish: boolean; serverMuted: boolean }> {
  const body = await json<{ token: string; serverVoiceSettings: { serverMuted: boolean } }>(res);
  const claims = decodeJwt(body.token);
  const video = (claims.video ?? {}) as { canPublishSources?: Array<string | number>; canPublish?: boolean };
  return {
    sources: (video.canPublishSources ?? []).map((s) => String(s).toLowerCase()),
    canPublish: video.canPublish !== false,
    serverMuted: body.serverVoiceSettings.serverMuted,
  };
}

// ── Set-up ─────────────────────────────────────────────────────────────

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  pw = playwright;
  resetRateLimits();
  browser = await launchRealUi(playwright);
  ownerPerson = await ownerContext(browser);
  owner = await pw.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN, storageState: await ownerPerson.ctx.storageState() });
  extraContexts.push(owner);
  serverId = await firstServerId(owner);
  everyoneId = (await everyoneRole(owner, serverId)).id;
  people.owner = { api: owner, uid: ownerPerson.uid, name: ownerPerson.name };

  // Roles, lowest first (a new role at a position pushes the ones at or above it up).
  await makeRole('novoice', ['send_messages', 'read_message_history'], 1);
  await makeRole('nohist', ['send_messages', 'connect_voice'], 2);
  await makeRole('staff', [], 3); // gates the staff room; nobody below holds it
  await makeRole('lowadmin', ['administrator'], 4); // LOW, but carries administrator
  await makeRole('gate', [], 5);
  await makeRole('chanmgr', ['manage_channels'], 6);
  await makeRole('botmgr', ['manage_server'], 7);
  await makeRole('helper', ['kick_members'], 8);
  await makeRole('mod', [
    'manage_messages', 'kick_members', 'ban_members', 'moderate_members', 'mute_members',
    'manage_roles', 'view_audit_log', 'create_polls',
  ], 9);
  await makeRole('admin', ['administrator'], 10);
  await refreshRoles();

  await makeChannel('chat', 'text');
  await makeChannel('mods', 'text', ['mod']);
  await makeChannel('staff', 'text', ['staff']);
  await makeChannel('voice', 'voice');

  // People.
  people.admin = await account('Admin');
  people.mod = await account('Mod');
  people.member = await account('Member');
  for (const [key, seed] of [
    ['helper', 'Helper'], ['mod2', 'ModTwo'], ['botmgr', 'BotMgr'], ['chanmgr', 'ChanMgr'],
    ['fresh', 'Fresh'], ['nohist', 'NoHist'], ['novoice', 'NoVoice'],
  ] as const) {
    people[key] = await guest(seed);
  }
  await assign('admin', ['admin']);
  await assign('mod', ['mod']);
  await assign('mod2', ['mod']);
  await assign('helper', ['helper']);
  await assign('botmgr', ['botmgr']);
  await assign('chanmgr', ['chanmgr']);
  await assign('nohist', ['nohist'], { withEveryone: false });
  await assign('novoice', ['novoice'], { withEveryone: false });
});

test.afterAll(async () => {
  resetRateLimits();
  if (owner && serverId) {
    for (const botId of createdBotIds) await send(() => owner.delete(`/api/servers/${serverId}/bots/${botId}`)).catch(() => undefined);
    for (const id of createdChannelIds) await send(() => owner.delete(`/api/servers/${serverId}/channels/${id}`)).catch(() => undefined);
    for (const id of createdRoleIds.reverse()) await send(() => owner.delete(`/api/servers/${serverId}/roles/${id}`)).catch(() => undefined);
    psql(`delete from audit_logs where server_id = '${serverId}' and metadata->>'code' = 'LEGACY${RUN.toUpperCase()}'`);
  }
  for (const ctx of extraContexts) await ctx.dispose().catch(() => undefined);
  await ownerPerson?.ctx.close().catch(() => undefined);
  await browser?.close();
});

// ── The matrix ─────────────────────────────────────────────────────────

test('view channel: a role-gated channel is hidden from the list and refused on read, write and voice', async () => {
  for (const name of ['member', 'fresh', 'helper', 'nohist']) {
    const ids = await channelIdsOf(name);
    expect(ids, `${name} sees #chat`).toContain(channels.chat);
    expect(ids, `${name} must not see #mods`).not.toContain(channels.mods);
    expect(ids, `${name} must not see #staff`).not.toContain(channels.staff);
  }
  expect(await channelIdsOf('mod')).toContain(channels.mods);
  expect(await channelIdsOf('mod')).not.toContain(channels.staff);
  // Administrator and Manage Channels see every channel.
  for (const name of ['admin', 'chanmgr']) {
    const ids = await channelIdsOf(name);
    expect(ids).toContain(channels.mods);
    expect(ids).toContain(channels.staff);
  }
  // Refused on read, history and write — with no hint the channel exists.
  for (const path of [`/channels/${channels.mods}`, `/channels/${channels.mods}/messages`]) {
    expect([403, 404], path).toContain((await send(() => api('member').get(`/api/servers/${serverId}${path}`))).status());
  }
  expect([403, 404]).toContain((await post('member', 'mods', `sneaking in ${RUN}`)).status());
  expect((await post('mod', 'mods', `mods only ${RUN}`)).status()).toBe(201);
  expect((await send(() => api('mod').get(`/api/servers/${serverId}/channels/${channels.mods}/messages`))).status()).toBe(200);
});

test('send messages: allowed with the permission, refused without it', async () => {
  expect((await post('member', 'chat', `hello from member ${RUN}`)).status()).toBe(201);
  expect((await post('fresh', 'chat', `hello from fresh ${RUN}`)).status()).toBe(201);
  // nohist and novoice both hold Send Messages; a role without it:
  const silent = await guest('Silent');
  people.silent = silent;
  await assign('silent', ['gate'], { withEveryone: false });
  const res = await post('silent', 'chat', `can I talk? ${RUN}`);
  expect(res.status()).toBe(403);
});

test('read message history: refused over REST, and the live chat subscription is refused too', async () => {
  expect((await send(() => api('nohist').get(`/api/servers/${serverId}/channels/${channels.chat}/messages`))).status()).toBe(403);
  expect((await send(() => api('member').get(`/api/servers/${serverId}/channels/${channels.chat}/messages`))).status()).toBe(200);
  // Posting stays allowed (a write-only channel).
  expect((await post('nohist', 'chat', `write-only ${RUN}`)).status()).toBe(201);

  // The gateway, from a real page (it checks the Origin of the upgrade).
  const answers: Record<string, string> = {};
  for (const name of ['nohist', 'member']) {
    const ctx = await browser.newContext({ baseURL: baseUrl, storageState: await api(name).storageState() });
    try {
      const page = await ctx.newPage();
      await page.goto(`/lobby?server=${serverId}`);
      const realtimeUrl = await page.locator('meta[name="lobbyforge-realtime-url"]').getAttribute('content');
      expect(realtimeUrl, 'the lobby names its realtime endpoint').toBeTruthy();
      answers[name] = await page.evaluate(
        async ({ url, topic }) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => resolve('timeout'), 10_000);
            ws.onmessage = (event) => {
              const msg = JSON.parse(String(event.data)) as { type: string; topic?: string; code?: string };
              if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', topic }));
              if (msg.type === 'subscribed' && msg.topic === topic) {
                clearTimeout(timer);
                resolve('subscribed');
                ws.close();
              }
              if (msg.type === 'error' && msg.topic === topic) {
                clearTimeout(timer);
                resolve(`error:${msg.code}`);
                ws.close();
              }
            };
            ws.onerror = () => resolve('socket-error');
          }),
        { url: realtimeUrl!, topic: `chat:${serverId}:${channels.chat}` }
      );
    } finally {
      await ctx.close();
    }
  }
  expect(answers.nohist).toBe('error:forbidden');
  expect(answers.member).toBe('subscribed');
});

test('manage messages: a moderator deletes someone else’s message; nobody else can', async () => {
  const byMember = await post('member', 'chat', `delete me ${RUN}`);
  expect(byMember.status()).toBe(201);
  const memberMsg = (await json<{ message: { id: string } }>(byMember)).message.id;
  const byMod = await post('mod', 'chat', `mod speaking ${RUN}`);
  const modMsg = (await json<{ message: { id: string } }>(byMod)).message.id;
  const del = (name: string, id: string) =>
    send(() => api(name).delete(`/api/servers/${serverId}/channels/${channels.chat}/messages/${id}`));
  expect((await del('fresh', memberMsg)).status()).toBe(403);
  expect((await del('helper', memberMsg)).status()).toBe(403);
  expect((await del('member', modMsg)).status()).toBe(403);
  expect((await del('mod', memberMsg)).status()).toBe(200);
  // Manage Messages still never rewrites someone else’s text.
  const edit = await send(() =>
    api('mod').patch(`/api/servers/${serverId}/channels/${channels.chat}/messages/${modMsg}`, { data: { content: 'own edit ok' } })
  );
  expect(edit.status()).toBe(200);
});

test('mention everyone: refused without the permission, allowed with it', async ({}, testInfo) => {
  expect((await post('nohist', 'chat', `hey @everyone ${RUN}`)).status()).toBe(403);
  expect((await post('member', 'chat', `hey @everyone ${RUN}`)).status()).toBe(201);
  // A mention glued to punctuation counts too (it used to slip through).
  const glued = await post('nohist', 'chat', `(@everyone) ${RUN}`);
  note(testInfo, { type: 'glued @everyone without the permission', description: `HTTP ${glued.status()}` });
  expect(glued.status()).toBe(403);
  // … and so does an edit: post something harmless, then edit @everyone in.
  const harmless = await post('nohist', 'chat', `hello ${RUN}`);
  expect(harmless.status()).toBe(201);
  const harmlessId = (await json<{ message: { id: string } }>(harmless)).message.id;
  const edited = await send(() =>
    api('nohist').patch(`/api/servers/${serverId}/channels/${channels.chat}/messages/${harmlessId}`, { data: { content: `hello @everyone ${RUN}` } })
  );
  note(testInfo, { type: '@everyone edited in without the permission', description: `HTTP ${edited.status()}` });
  expect(edited.status()).toBe(403);
  // Polls follow the message rule.
  const poll = await send(() =>
    api('mod').post(`/api/servers/${serverId}/channels/${channels.chat}/polls`, {
      data: { question: `@everyone vote ${RUN}`, options: ['a', 'b'] },
    })
  );
  expect(poll.status(), 'mod (no Mention Everyone beyond @everyone’s) — @everyone holds it').toBe(201);
});

test('create polls: refused without the permission, allowed with it', async () => {
  const create = (name: string) =>
    send(() =>
      api(name).post(`/api/servers/${serverId}/channels/${channels.chat}/polls`, {
        data: { question: `Pizza or pasta? ${RUN}`, options: ['Pizza', 'Pasta'] },
      })
    );
  expect((await create('member')).status()).toBe(403);
  expect((await create('fresh')).status()).toBe(403);
  expect((await create('mod')).status()).toBe(201);
  expect((await create('admin')).status()).toBe(201);
});

test('manage channels: refused without the permission, allowed with it', async () => {
  const create = (name: string) =>
    send(() => api(name).post(`/api/servers/${serverId}/channels`, { data: { name: `mx-new-${name}-${RUN}`, type: 'text' } }));
  expect((await create('member')).status()).toBe(403);
  expect((await create('mod')).status()).toBe(403);
  for (const name of ['chanmgr', 'admin']) {
    const res = await create(name);
    expect(res.status(), name).toBe(201);
    const id = (await json<{ channel: { id: string } }>(res)).channel.id;
    createdChannelIds.push(id);
    expect((await send(() => api('member').delete(`/api/servers/${serverId}/channels/${id}`))).status()).toBe(403);
    expect((await send(() => api(name).delete(`/api/servers/${serverId}/channels/${id}`))).status()).toBe(200);
  }
  expect((await send(() => api('member').patch(`/api/servers/${serverId}/channels/${channels.chat}`, { data: { topic: 'x' } }))).status()).toBe(403);
});

test('manage roles: no granting what you lack, nothing at or above your highest, @everyone stays lowest, administrator only from the owner', async () => {
  await refreshRoles();
  const modPos = roles.mod!.position;
  const createAs = (name: string, data: Record<string, unknown>) =>
    send(() => api(name).post(`/api/servers/${serverId}/roles`, { data: { name: `mx-by-${name}-${RUN}`, ...data } }));
  const patchAs = (name: string, roleId: string, data: Record<string, unknown>) =>
    send(() => api(name).patch(`/api/servers/${serverId}/roles/${roleId}`, { data }));

  // Without Manage Roles: nothing.
  expect((await createAs('member', { permissions: [] })).status()).toBe(403);
  expect((await patchAs('helper', roles.novoice!.id, { name: 'renamed' })).status()).toBe(403);

  // A moderator: what they hold, below themselves.
  const ok = await createAs('mod', { permissions: ['ban_members'], position: 2 });
  expect(ok.status(), await ok.text()).toBe(201);
  createdRoleIds.push((await json<{ role: { id: string } }>(ok)).role.id);
  const lacking = await createAs('mod', { permissions: ['manage_server'], position: 2 });
  expect(lacking.status()).toBe(403);
  expect((await json<{ permissions: string[] }>(lacking)).permissions).toEqual(['manage_server']);
  expect((await createAs('mod', { permissions: ['administrator'], position: 2 })).status()).toBe(403);
  expect((await createAs('mod', { permissions: [], position: modPos })).status()).toBe(403);
  expect((await createAs('mod', { permissions: [], position: modPos + 5 })).status()).toBe(403);

  // Editing: below only — not their own role, not the admin role.
  expect((await patchAs('mod', roles.admin!.id, { name: 'pwned' })).status()).toBe(403);
  expect((await patchAs('mod', roles.mod!.id, { permissions: [...roles.mod!.permissions, 'administrator'] })).status()).toBe(403);
  expect((await patchAs('mod', roles.mod!.id, { permissions: [...roles.mod!.permissions, 'manage_server'] })).status()).toBe(403);
  // A lower role: may add what they hold, never what they lack.
  const addHeld = await patchAs('mod', roles.helper!.id, { permissions: ['kick_members', 'ban_members'] });
  expect(addHeld.status(), await addHeld.text()).toBe(200);
  expect((await patchAs('mod', roles.helper!.id, { permissions: ['kick_members', 'manage_channels'] })).status()).toBe(403);
  expect((await patchAs('mod', roles.helper!.id, { permissions: ['kick_members'] })).status()).toBe(200);
  // @everyone: never moved, by anyone (the owner included); nothing goes under it.
  for (const name of ['mod', 'admin']) {
    const move = await patchAs(name, everyoneId, { position: 3 });
    expect(move.status(), `${name} moves @everyone`).toBe(400);
    expect(await code(move)).toBe('everyone_role_lowest');
  }
  const ownerMove = await send(() => owner.patch(`/api/servers/${serverId}/roles/${everyoneId}`, { data: { position: 3 } }));
  expect(await code(ownerMove)).toBe('everyone_role_lowest');
  const under = await patchAs('mod', roles.helper!.id, { position: 0 });
  expect(under.status()).toBe(400);
  expect(await code(under)).toBe('everyone_role_lowest');
  // @everyone may not be handed a permission the editor lacks (beta-review S1).
  expect((await patchAs('mod', everyoneId, { permissions: ['send_messages', 'administrator'] })).status()).toBe(403);
  expect((await patchAs('mod', everyoneId, { permissions: ['send_messages', 'manage_server'] })).status()).toBe(403);

  // Assigning: below only, and no role that carries what they lack.
  const assignAs = (actor: string, target: string, keys: string[]) =>
    send(() =>
      api(actor).put(`/api/servers/${serverId}/members/${uid(target)}/role`, {
        data: { roleIds: [everyoneId, ...keys.map((k) => roles[k]!.id)] },
      })
    );
  expect((await assignAs('mod', 'member', ['admin'])).status()).toBe(403);
  expect((await assignAs('mod', 'member', ['mod'])).status()).toBe(403);
  const lowAdmin = await assignAs('mod', 'member', ['lowadmin']);
  expect(lowAdmin.status()).toBe(403);
  expect((await json<{ permissions: string[] }>(lowAdmin)).permissions).toContain('administrator');
  expect((await assignAs('mod', 'member', ['helper'])).status()).toBe(200);
  expect((await assignAs('mod', 'member', [])).status()).toBe(200);

  // Escalation on yourself.
  const self = await assignAs('mod', 'mod', ['mod', 'admin']);
  expect(self.status()).toBe(400);
  expect(await code(self)).toBe('self_action');
  expect((await assignAs('helper', 'helper', ['mod'])).status()).toBe(403);

  // A non-owner administrator never grants administrator.
  expect((await createAs('admin', { permissions: ['administrator'], position: 2 })).status()).toBe(403);
  expect((await patchAs('admin', roles.helper!.id, { permissions: ['kick_members', 'administrator'] })).status()).toBe(403);
  expect((await assignAs('admin', 'member', ['lowadmin'])).status()).toBe(403);
  const adminGrants = await createAs('admin', { permissions: ['manage_server', 'ban_members'], position: 2 });
  expect(adminGrants.status(), 'administrator holds every other permission').toBe(201);
  createdRoleIds.push((await json<{ role: { id: string } }>(adminGrants)).role.id);
  // … and never edits a role at or above their own (the owner's role included).
  const ownerRole = (await json<{ roles: RoleRow[] }>(await owner.get(`/api/servers/${serverId}/roles`))).roles.find((r) => r.name === 'Owner');
  if (ownerRole) expect((await patchAs('admin', ownerRole.id, { name: 'mine now' })).status()).toBe(403);
  expect((await patchAs('admin', roles.admin!.id, { name: 'mine now' })).status()).toBe(403);
});

test('kick, ban and timeout: the hierarchy holds, the owner is immune, a timed-out actor is refused', async () => {
  const victim1 = await guest('Victim1');
  people.victim1 = victim1;
  const kick = (actor: string, target: string) =>
    send(() => api(actor).delete(`/api/servers/${serverId}/members/${uid(target)}`));
  const ban = (actor: string, target: string) =>
    send(() => api(actor).post(`/api/servers/${serverId}/bans`, { data: { userId: uid(target), reason: `matrix ${RUN}` } }));
  const timeout = (actor: string, target: string, minutes: number | null) =>
    send(() =>
      api(actor).put(`/api/servers/${serverId}/members/${uid(target)}/timeout`, {
        data: { until: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString() },
      })
    );

  // No permission (the kick and ban routes check it before the shared gate, without a code).
  expect((await kick('member', 'victim1')).status()).toBe(403);
  expect((await ban('helper', 'victim1')).status()).toBe(403);
  expect((await timeout('helper', 'victim1', 5)).status()).toBe(403);
  // Rank: below may not touch above, equal may not touch equal.
  expect(await code(await kick('helper', 'mod'))).toBe('insufficient_rank');
  expect(await code(await kick('mod', 'mod2'))).toBe('insufficient_rank');
  expect(await code(await ban('mod', 'admin'))).toBe('insufficient_rank');
  expect(await code(await timeout('mod', 'admin', 5))).toBe('insufficient_rank');
  // The owner: immune to everyone, administrators included (kick and ban
  // refuse the owner before the shared gate: 400 with their own message).
  for (const actor of ['admin', 'mod', 'helper']) {
    const res = await kick(actor, 'owner');
    expect(res.status(), `${actor} kicks the owner`).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe('Cannot kick the server owner');
  }
  const banOwner = await ban('admin', 'owner');
  expect(banOwner.status()).toBe(400);
  expect((await json<{ error: string }>(banOwner)).error).toBe('Cannot ban the server owner');
  expect(await code(await timeout('admin', 'owner', 5))).toBe('target_is_owner');
  // Self.
  expect(await code(await ban('mod', 'mod'))).toBe('self_action');

  // A timed-out moderator moderates nobody.
  expect((await timeout('mod', 'helper', 30)).status()).toBe(200);
  const refused = await kick('helper', 'victim1');
  expect(refused.status()).toBe(403);
  expect(await code(refused)).toBe('actor_timed_out');
  // The timed-out member still can't talk either.
  expect((await post('helper', 'chat', `muffled ${RUN}`)).status()).toBe(403);
  expect((await timeout('mod', 'helper', null)).status()).toBe(200);
  // Allowed: down the ladder.
  expect((await kick('helper', 'victim1')).status()).toBe(200);
  const code1 = await newInviteCode(owner, serverId);
  expect((await redeem(api('victim1'), code1)).status()).toBe(201);
  expect((await ban('mod', 'victim1')).status()).toBe(201);
});

test('a timed-out moderator cannot lift a ban either', async ({}, testInfo) => {
  // The gate covers kick, ban, timeout (set and clear), roles, voice mute
  // and disconnect (docs/ROLES.md). Unbanning is the other half of a ban.
  people.banned = await guest('Banned');
  expect((await send(() => owner.post(`/api/servers/${serverId}/bans`, { data: { userId: uid('banned') } }))).status()).toBe(201);
  expect((await send(() => api('mod2').get(`/api/servers/${serverId}/bans`))).status()).toBe(200);
  expect(
    (
      await send(() =>
        api('mod').put(`/api/servers/${serverId}/members/${uid('mod2')}/timeout`, {
          data: { until: new Date(Date.now() + 30 * 60_000).toISOString() },
        })
      )
    ).status()
  ).toBe(403); // equal rank — the owner times mod2 out instead
  expect(
    (
      await send(() =>
        owner.put(`/api/servers/${serverId}/members/${uid('mod2')}/timeout`, {
          data: { until: new Date(Date.now() + 30 * 60_000).toISOString() },
        })
      )
    ).status()
  ).toBe(200);
  try {
    const unban = await send(() => api('mod2').delete(`/api/servers/${serverId}/bans?userId=${uid('banned')}`));
    note(testInfo, { type: 'unban by a timed-out moderator', description: `HTTP ${unban.status()} ${await unban.text()}` });
    expect(unban.status(), 'a timed-out moderator lifted a ban').toBe(403);
    expect(await code(unban)).toBe('actor_timed_out');
  } finally {
    await send(() => owner.put(`/api/servers/${serverId}/members/${uid('mod2')}/timeout`, { data: { until: null } }));
  }
  // Still banned: the invite is refused.
  expect((await redeem(api('banned'), await newInviteCode(owner, serverId))).status()).toBe(403);
});

test('voice: connect, speak and stream are each enforced in the token', async () => {
  const member = await voiceToken('member', 'voice');
  expect(member.status()).toBe(200);
  const memberGrant = await publishSources(member);
  expect(memberGrant.sources.join(',')).toMatch(/microphone|1/);
  expect(memberGrant.sources.length).toBeGreaterThanOrEqual(3); // mic, camera, screen (+ screen audio)

  // nohist: Connect Voice, but no Speak and no Stream.
  const nohist = await voiceToken('nohist', 'voice');
  expect(nohist.status()).toBe(200);
  const noSpeak = await publishSources(nohist);
  expect(noSpeak.canPublish).toBe(false);
  expect(noSpeak.sources).toEqual([]);

  // novoice: no Connect Voice → no token at all.
  expect((await voiceToken('novoice', 'voice')).status()).toBe(403);
  // A gated channel is refused like any other read of it.
  const gatedVoice = await makeChannel('modvoice', 'voice', ['mod']);
  expect(gatedVoice).toBeTruthy();
  expect([403, 404]).toContain((await voiceToken('member', 'modvoice')).status());
  expect((await voiceToken('mod', 'modvoice')).status()).toBe(200);
});

test('server mute and voice disconnect: Mute Members with the hierarchy; deafening others does not exist', async () => {
  const mute = (actor: string, target: string, muted: boolean) =>
    send(() =>
      api(actor).post(`/api/servers/${serverId}/channels/${channels.voice}/members/${uid(target)}/voice/mute`, { data: { muted } })
    );
  const disconnect = (actor: string, target: string) =>
    send(() => api(actor).post(`/api/servers/${serverId}/channels/${channels.voice}/members/${uid(target)}/voice/disconnect`, { data: {} }));
  expect(await code(await mute('helper', 'member', true))).toBe('forbidden');
  expect(await code(await mute('mod', 'admin', true))).toBe('insufficient_rank');
  expect(await code(await mute('mod', 'owner', true))).toBe('target_is_owner');
  expect(await code(await disconnect('admin', 'owner'))).toBe('target_is_owner');
  expect(await code(await disconnect('member', 'fresh'))).toBe('forbidden');
  expect((await mute('mod', 'fresh', true)).status()).toBe(200);
  const muted = await publishSources(await voiceToken('fresh', 'voice'));
  expect(muted.serverMuted).toBe(true);
  expect(muted.sources.some((s) => s.includes('microphone') || s === '2')).toBe(false);
  expect((await mute('mod', 'fresh', false)).status()).toBe(200);
  expect((await publishSources(await voiceToken('fresh', 'voice'))).serverMuted).toBe(false);
});

test('manage server (Manage Community): refused without it, allowed with it', async ({}, testInfo) => {
  const patch = (name: string) =>
    send(() => api(name).patch(`/api/servers/${serverId}/voice-settings`, { data: { startMuted: false } }));
  expect((await patch('member')).status()).toBe(403);
  expect((await patch('mod')).status()).toBe(403);
  expect((await patch('botmgr')).status()).toBe(200);
  // The access policy: every member may read it, only Manage Community changes it.
  const read = await send(() => api('member').get(`/api/servers/${serverId}/access-policy`));
  expect(read.status()).toBe(200);
  const body = (await json<{ accessPolicy: Record<string, unknown> }>(read)).accessPolicy;
  note(testInfo, { type: 'access policy read by a plain member', description: JSON.stringify(body) });
  expect((await send(() => api('member').patch(`/api/servers/${serverId}/access-policy`, { data: body }))).status()).toBe(403);
  expect((await send(() => api('mod').patch(`/api/servers/${serverId}/access-policy`, { data: body }))).status()).toBe(403);
});

test('view audit log: refused without it; viewers without access never see invite codes or hidden channels', async () => {
  expect((await send(() => api('member').get(`/api/servers/${serverId}/audit-logs`))).status()).toBe(403);
  // A legacy row from before invite codes stopped being logged.
  const legacy = `LEGACY${RUN.toUpperCase()}`;
  expect(
    psql(
      `insert into audit_logs (server_id, actor_user_id, action, target_type, target_id, metadata) values ('${serverId}', '${ownerPerson.uid}', 'invite.create', 'invite', '${legacy}', '{"code":"${legacy}","maxUses":null}')`
    )
  ).not.toBeNull();
  const read = async (name: string | null) => {
    const res = await send(() => (name ? api(name) : owner).get(`/api/servers/${serverId}/audit-logs?limit=200`));
    expect(res.status(), `${name ?? 'owner'} reads the audit log`).toBe(200);
    return res.text();
  };
  const asOwner = await read(null);
  expect(asOwner).toContain(`"code":"${legacy}"`);
  expect(asOwner).toContain(`mxc-staff-${RUN}`);
  const asMod = await read('mod');
  expect(asMod, 'the invite code (metadata) is projected out').not.toContain(`"code":"${legacy}"`);
  expect(asMod, 'a channel the moderator cannot see stays unnamed').not.toContain(`mxc-staff-${RUN}`);
  expect(asMod, 'a channel the moderator can see is named').toContain(`mxc-mods-${RUN}`);
  // Codes of live invites never reach the log at all.
  const live = await newInviteCode(owner, serverId);
  expect(await read('mod')).not.toContain(live);
  expect(await read(null)).not.toContain(live);
});

test('manage bots: a manager who cannot see a bot’s private channel cannot take its token or widen it', async () => {
  const create = await send(() =>
    owner.post(`/api/servers/${serverId}/bots`, { data: { name: `Matrix Bot ${RUN}`, permissions: ['send_messages'] } })
  );
  expect(create.status(), await create.text()).toBe(201);
  const botId = (await json<{ bot: { id: string } }>(create)).bot.id;
  createdBotIds.push(botId);
  // The owner grants it the staff room (hidden from botmgr).
  const grant = await send(() =>
    owner.put(`/api/servers/${serverId}/bots/${botId}/channel-access`, { data: { channelIds: [channels.chat, channels.staff] } })
  );
  expect(grant.status(), await grant.text()).toBe(200);

  const asMgr = api('botmgr');
  // Allowed: what does not reach further.
  expect((await send(() => asMgr.patch(`/api/servers/${serverId}/bots/${botId}`, { data: { name: `Renamed ${RUN}` } }))).status()).toBe(200);
  // Refused: a channel permission, the token, dropping the per-channel mode.
  const widen = await send(() => asMgr.patch(`/api/servers/${serverId}/bots/${botId}`, { data: { permissions: ['send_messages', 'read_messages'] } }));
  expect(widen.status()).toBe(403);
  expect(await code(widen)).toBe('cannot_take_hidden_access');
  const rotate = await send(() => asMgr.post(`/api/servers/${serverId}/bots/${botId}/token`, { data: {} }));
  expect(rotate.status()).toBe(403);
  expect(await code(rotate)).toBe('cannot_take_hidden_access');
  const all = await send(() => asMgr.put(`/api/servers/${serverId}/bots/${botId}/channel-access`, { data: { channelIds: null } }));
  expect(all.status()).toBe(403);
  expect(await code(all)).toBe('cannot_change_hidden_access');
  const grantHidden = await send(() =>
    asMgr.put(`/api/servers/${serverId}/bots/${botId}/channel-access`, { data: { channelIds: [channels.chat, channels.mods] } })
  );
  // A channel the manager cannot see answers like one that does not exist.
  expect(grantHidden.status()).toBe(400);
  expect(await code(grantHidden)).toBe('invalid_channel');
  // No Manage Community at all.
  expect((await send(() => api('mod').patch(`/api/servers/${serverId}/bots/${botId}`, { data: { name: 'nope' } }))).status()).toBe(403);
  // The listing never carries a token.
  const list = await send(() => asMgr.get(`/api/servers/${serverId}/bots`));
  expect(list.status()).toBe(200);
  expect(await list.text()).not.toMatch(/"token"\s*:/);
});

test('administrator: everything below the owner — but not the owner, and not administrator itself', async () => {
  expect((await send(() => api('admin').get(`/api/servers/${serverId}/audit-logs`))).status()).toBe(200);
  expect(await channelIdsOf('admin')).toContain(channels.staff);
  const victim2 = await guest('Victim2');
  people.victim2 = victim2;
  expect((await send(() => api('admin').post(`/api/servers/${serverId}/bans`, { data: { userId: victim2.uid } }))).status()).toBe(201);
  expect((await send(() => api('admin').delete(`/api/servers/${serverId}/bans?userId=${victim2.uid}`))).status()).toBe(200);
  expect((await send(() => api('admin').patch(`/api/servers/${serverId}/voice-settings`, { data: { startMuted: false } }))).status()).toBe(200);
  expect((await send(() => api('admin').delete(`/api/servers/${serverId}/members/${ownerPerson.uid}`))).status()).toBe(400);
});

test('deleting the last role that gates channels: 409, naming only channels the actor can see', async () => {
  const gated = await makeRole('lastgate', [], 3);
  await makeChannel('g1', 'text', ['lastgate']);
  await makeChannel('g2', 'text', ['lastgate']);
  // The moderator (Manage Roles, without Manage Channels, without the role) sees neither.
  const asMod = await send(() => api('mod').delete(`/api/servers/${serverId}/roles/${gated.id}`));
  expect(asMod.status()).toBe(409);
  const modBody = await json<{ code: string; channels: Array<{ id: string; name?: string }>; hiddenChannelCount: number }>(asMod);
  expect(modBody.code).toBe('role_gates_channels');
  expect(modBody.channels).toEqual([]);
  expect(modBody.hiddenChannelCount).toBe(2);
  expect(JSON.stringify(modBody)).not.toContain(`mxc-g1-${RUN}`);
  // With the role, they see both — and both are named.
  await assign('mod', ['mod', 'lastgate']);
  const asModWithRole = await json<{ channels: Array<{ id: string }>; hiddenChannelCount: number }>(
    await send(() => api('mod').delete(`/api/servers/${serverId}/roles/${gated.id}`))
  );
  expect(asModWithRole.channels.map((c) => c.id).sort()).toEqual([channels.g1, channels.g2].sort());
  expect(asModWithRole.hiddenChannelCount).toBe(0);
  await assign('mod', ['mod']);
  // The owner sees all; the role is still there.
  const asOwner = await send(() => owner.delete(`/api/servers/${serverId}/roles/${gated.id}`));
  expect(asOwner.status()).toBe(409);
  expect((await json<{ hiddenChannelCount: number }>(asOwner)).hiddenChannelCount).toBe(0);
  expect((await send(() => owner.get(`/api/servers/${serverId}/roles/${gated.id}`))).status()).toBe(200);
});

test('sanctions persist: a ban, a timeout and a server mute survive leaving and coming back', async () => {
  const leaver = await guest('Leaver');
  people.leaver = leaver;
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  expect((await send(() => owner.put(`/api/servers/${serverId}/members/${leaver.uid}/timeout`, { data: { until } }))).status()).toBe(200);
  expect(
    (await send(() => owner.post(`/api/servers/${serverId}/channels/${channels.voice}/members/${leaver.uid}/voice/mute`, { data: { muted: true } }))).status()
  ).toBe(200);
  // Leave, and come back through a new invite.
  expect((await send(() => leaver.api.delete(`/api/servers/${serverId}/members/${leaver.uid}`))).status()).toBe(200);
  expect((await redeem(leaver.api, await newInviteCode(owner, serverId))).status()).toBe(201);
  expect((await post('leaver', 'chat', `back and free? ${RUN}`)).status()).toBe(403);
  const grant = await publishSources(await voiceToken('leaver', 'voice'));
  expect(grant.serverMuted).toBe(true);
  expect(grant.canPublish).toBe(false); // timed out: nothing at all
  // Lift the timeout: the server mute is still there on its own.
  expect((await send(() => owner.put(`/api/servers/${serverId}/members/${leaver.uid}/timeout`, { data: { until: null } }))).status()).toBe(200);
  const stillMuted = await publishSources(await voiceToken('leaver', 'voice'));
  expect(stillMuted.serverMuted).toBe(true);
  expect(stillMuted.sources.length).toBeGreaterThan(0); // camera / screen stay
  expect(stillMuted.sources.some((s) => s.includes('microphone'))).toBe(false);
  // The ban: banned while a member, leaves… cannot come back.
  expect((await send(() => owner.post(`/api/servers/${serverId}/bans`, { data: { userId: leaver.uid } }))).status()).toBe(201);
  expect((await redeem(leaver.api, await newInviteCode(owner, serverId))).status()).toBe(403);
  expect([403, 404]).toContain((await send(() => leaver.api.get(`/api/servers/${serverId}/channels`))).status());
});

test('the UI matches: community menu, admin pages, channel settings gear, the voice roster menu', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  const open = async (name: string): Promise<Page> => {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      permissions: ['microphone'],
      storageState: people[name]!.storage ?? (await api(name).storageState()),
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on('dialog', (dialog) => void dialog.accept());
    return page;
  };
  const shot = (name: string) => (theme: 'dark' | 'light') =>
    SHOT_DIR ? join(SHOT_DIR, `${name}-${theme}.png`) : testInfo.outputPath(`${name}-${theme}.png`);
  try {
    const member = await open('member');
    const mod = await open('mod');
    const menuEntries = async (page: Page) => {
      await page.goto(`/lobby?server=${serverId}`);
      await page.getByTitle(/open the community menu/).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      return (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.replace(/^\S+\s+/, '').trim());
    };
    const memberMenu = await menuEntries(member);
    expect(memberMenu.join('|')).not.toMatch(/Members|Roles|Channels|Invites|Server settings|Apps/);
    expect(memberMenu.join('|')).toMatch(/User settings/);
    const modMenu = await menuEntries(mod);
    expect(modMenu.join('|')).toMatch(/Members/);
    expect(modMenu.join('|')).toMatch(/Roles & permissions/);
    expect(modMenu.join('|')).not.toMatch(/Channels|Invites|Server settings|Apps/);
    await shootBothThemes(mod, shot('matrix-1-mod-community-menu'));
    note(testInfo, { type: 'community menu', description: `member: ${memberMenu.join(', ')} | mod: ${modMenu.join(', ')}` });
    await mod.keyboard.press('Escape');

    // Admin pages: a real 404 without the permission.
    const status = async (page: Page, path: string) => (await page.goto(path))?.status() ?? 0;
    for (const path of ['/admin/settings/members', '/admin/settings/roles', '/admin/audit', '/admin/settings/channels', '/admin/settings']) {
      expect(await status(member, path), `member ${path}`).toBe(404);
    }
    expect(await status(mod, '/admin/settings/members')).toBe(200);
    expect(await status(mod, '/admin/settings/roles')).toBe(200);
    expect(await status(mod, '/admin/audit')).toBe(200);
    expect(await status(mod, '/admin/settings/channels')).toBe(404);
    expect(await status(mod, '/admin/settings/invites')).toBe(404);
    expect(await status(mod, '/admin/settings')).toBe(404);

    // The channel settings gear: Manage Channels only.
    const gear = (page: Page) => page.getByRole('link', { name: `Settings for mxc-voice-${RUN}` });
    for (const page of [member, mod]) {
      await page.goto(`/lobby?server=${serverId}`);
      await expect(page.getByRole('button', { name: `mxc-voice-${RUN}` }).first()).toBeVisible();
      await expect(gear(page)).toHaveCount(0);
    }
    const ownerPage = await ownerPerson.ctx.newPage();
    await ownerPage.goto(`/lobby?server=${serverId}`);
    await expect(gear(ownerPage)).toHaveCount(1);
    await ownerPage.close();

    // The voice roster's member menu: Mute Members only.
    const voiceButton = (page: Page) =>
      page.getByRole('button', { name: `mxc-voice-${RUN}` }).filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
    for (const page of [member, mod]) {
      await page.goto(`/lobby?server=${serverId}`);
      await voiceButton(page).click();
      await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
    }
    await expect(mod.getByRole('button', { name: `Voice actions for ${people.member!.name}` })).toHaveCount(1, { timeout: 15_000 });
    await expect(mod.getByRole('button', { name: `Server mute ${people.member!.name}` })).toHaveCount(1);
    await expect(member.getByRole('button', { name: `Server mute ${people.mod!.name}` })).toHaveCount(0);
    await expect(member.getByRole('button', { name: `Voice actions for ${people.mod!.name}` })).toHaveCount(0);
    // Right-click on the row opens the same menu.
    await mod.getByTestId('mobile-nav-drawer').locator('li.cursor-pointer').filter({ hasText: people.member!.name }).click({ button: 'right' });
    await expect(mod.getByRole('menuitem', { name: 'Disconnect from voice' })).toBeVisible();
    await shootBothThemes(mod, shot('matrix-2-mod-voice-member-menu'));
    await mod.keyboard.press('Escape');
    // The member's own right-click offers nothing.
    await member.getByTestId('mobile-nav-drawer').locator('li.cursor-pointer').filter({ hasText: people.mod!.name }).click({ button: 'right' });
    await expect(member.getByRole('menuitem', { name: 'Disconnect from voice' })).toHaveCount(0);
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
  }
});
