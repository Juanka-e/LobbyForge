/**
 * Regression checks for the 2026-10 security review
 * (docs/SECURITY_REVIEW_2026-10.md, top entry of docs/CHANGELOG.md),
 * against the REAL compose stack: Postgres, Redis and LiveKit.
 *
 * One test per finding, each self-contained: it makes its own guests,
 * roles and channels, and puts back anything server-wide it changes (the
 * access policy). Mostly API-level, the way an attacker would come at it;
 * the AUTHZ-006 tests drive livekit-client in real Chromium pages against
 * the stack's LiveKit to see what the server actually lets through.
 *
 *   AUTH-001   a desktop sign-in code dies with a password change
 *   AUTH-002   two session cookies are refused; a signed-out cookie no
 *              longer renders the lobby
 *   AUTHZ-001  the last role gating a channel cannot be deleted
 *   AUTHZ-002  a timeout survives leave + rejoin; timed-out members mint
 *              no invites; users who left can be banned
 *   AUTHZ-003  Manage Messages deletes and pins, never rewrites
 *   AUTHZ-004  "approval required" stops invite redemption
 *   AUTHZ-005 / FILE-001  avatars are short URLs, served with nosniff,
 *              and hidden by "Profile visibility: nobody"
 *   AUTHZ-006  publish grants: a member publishes mic, camera and screen;
 *              a server-muted member loses mic and screen audio but keeps
 *              camera and screen share; a timed-out member publishes
 *              nothing; a member who publishes audio under the Camera /
 *              ScreenShare source is removed by the server (LiveKit
 *              webhook) before the room hears more than a moment of it
 *   PLUG-001   a poll vote is not written to the audit log
 *   PLUG-002   a kicked host cannot end their activity
 *   FILE-002 / HUB-001  directory writes are official-hub only; the
 *              install has its own directory id
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL); LF_E2E_OFFICIAL_URL
 * (an official-mode web on the same stack) adds a positive control to
 * FILE-002. Tests run in order in one worker (`mode: 'default'`): AUTHZ-004
 * switches a server-wide policy for a moment. The routes' rate limits are
 * per client address and every context here shares one; a 429 is waited
 * out (Retry-After) and retried. Clear `*rate-limit*` keys in Redis before
 * a re-run straight after other specs.
 */
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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const officialUrl = process.env.LF_E2E_OFFICIAL_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMED_OUT = 'You are timed out in this server';

/** Escape every RegExp metacharacter (backslash included) in a literal. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
// In order, one worker; a failure does not skip the tests after it. The
// timeout leaves room for waiting out a rate-limit window (up to ~76 s).
test.describe.configure({ mode: 'default', timeout: 180_000 });

type Playwright = PlaywrightWorkerArgs['playwright'];

interface Member {
  api: APIRequestContext;
  uid: string;
  name: string;
}

declare global {
  interface Window {
    LivekitClient: any;
    __room: any;
    __events: Array<{ kind: string; source: string; from: string }>;
    __pcs: RTCPeerConnection[];
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────

/** Every context here shares one client address; wait out a 429 and retry. */
async function send(call: () => Promise<APIResponse>): Promise<APIResponse> {
  let res = await call();
  for (let attempt = 0; attempt < 2 && res.status() === 429; attempt += 1) {
    const wait = Math.min(Number(res.headers()['retry-after'] ?? '30') || 30, 75);
    console.info(`[rate-limit] 429 on ${res.url().replace(baseUrl, '')} — waiting ${wait + 1}s`);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    res = await call();
  }
  return res;
}

async function newApi(playwright: Playwright): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
}

/** A fresh guest: a materialized user with its own session cookie. */
async function newGuest(playwright: Playwright, seed: string): Promise<Member> {
  const api = await newApi(playwright);
  const res = await send(() => api.post('/api/auth/guest', { data: { displayNameSeed: `${seed} ${RUN.slice(-4)}` } }));
  expect(res.status(), `guest ${seed}`).toBe(200);
  const { guest } = (await res.json()) as { guest: { uid: string; name: string } };
  expect(guest.uid).toMatch(UUID_RE);
  return { api, uid: guest.uid, name: guest.name };
}

async function sessionCookie(api: APIRequestContext): Promise<string> {
  const { cookies } = await api.storageState();
  const cookie = cookies.find((c) => c.name === 'lf_guest');
  expect(cookie, 'lf_guest cookie').toBeTruthy();
  return cookie!.value;
}

/**
 * A request with exactly the Cookie header given — no jar, no redirects
 * followed (Node's fetch, so nothing a previous response set can leak in).
 */
async function rawRequest(path: string, cookie: string, init: { method?: string } = {}) {
  return fetch(new URL(path, baseUrl), {
    method: init.method ?? 'GET',
    headers: { Origin: baseUrl, Cookie: cookie },
    redirect: 'manual',
  });
}

/** The `video` grant of a LiveKit access token. */
function videoGrant(jwt: string): { canPublish?: boolean; canPublishSources?: string[]; room?: string } {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as {
    video: { canPublish?: boolean; canPublishSources?: string[]; room?: string };
  };
  return payload.video;
}

// ── A real 256×256 PNG (the avatar minimum), built in memory ──────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = Buffer.alloc(1 + size * 3); // filter byte 0 + pixels
  for (let x = 0; x < size; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── livekit-client in a real page ──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const LIVEKIT_UMD = resolve(here, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

/** Track every RTCPeerConnection the page creates so its stats can be read. */
function hookPeerConnections() {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  class Tracked extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      window.__pcs.push(this);
    }
  }
  window.RTCPeerConnection = Tracked as typeof RTCPeerConnection;
}

/**
 * A blank page at the app's origin that loads livekit-client — served by
 * route interception, so the app's CSP (which would block the inline
 * client and the LiveKit port) does not apply. Same as voice-two-clients.
 */
async function openLiveKitPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const umd = readFileSync(LIVEKIT_UMD, 'utf8');
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(hookPeerConnections);
  const page = await ctx.newPage();
  await page.route('**/lf-security-harness.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><script src="/lf-security-livekit-client.js"></script></body></html>',
    })
  );
  await page.route('**/lf-security-livekit-client.js', (route) =>
    route.fulfill({ body: umd, contentType: 'application/javascript' })
  );
  await page.goto(new URL('/lf-security-harness.html', baseUrl).toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.LivekitClient !== 'undefined');
  return { ctx, page };
}

/** Connect the page's livekit-client to the room; record every subscription. */
async function connectRoom(page: Page, url: string, token: string) {
  await page.evaluate(
    async ({ url, token }) => {
      const LK = window.LivekitClient;
      const room = new LK.Room({ adaptiveStream: false, peerConnectionTimeout: 45_000 });
      window.__room = room;
      window.__events = [];
      room.on(LK.RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
        window.__events.push({ kind: track.kind, source: track.source, from: participant.identity });
      });
      await room.connect(url, token, { autoSubscribe: true });
    },
    { url, token }
  );
}

/** Tracks the page has subscribed to from `identity`. */
async function subscriptionsFrom(page: Page, identity: string) {
  const events = await page.evaluate(() => window.__events);
  return events.filter((e) => e.from === identity);
}

/** Inbound audio bytes across every peer connection of the page. */
async function inboundAudioBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let bytes = 0;
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += Number(s.bytesReceived ?? 0);
      });
    }
    return bytes;
  });
}

/**
 * The audio a mislabelled track may deliver before the server removes its
 * publisher. The bug delivered ~8 KB/s per track (~82 KB in 5 s for two);
 * LiveKit's webhook + RemoveParticipant take a few hundred milliseconds,
 * so 16 KB (~2 s of one track) leaves headroom while still failing hard on
 * a track that keeps playing.
 */
const MAX_LEAKED_AUDIO_BYTES = 16_000;

/** Inbound audio bytes per stream (peer connection + SSRC) of the page. */
async function inboundAudioByStream(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const streams: Record<string, number> = {};
    for (const [index, pc] of (window.__pcs ?? []).entries()) {
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          streams[`${index}:${String(s.ssrc)}`] = Number(s.bytesReceived ?? 0);
        }
      });
    }
    return streams;
  });
}

/**
 * Sample the page's inbound audio every 250 ms for `ms`, keeping each
 * stream's PEAK in `peaks`: a removed track's stats can vanish from
 * getStats(), so the last reading would under-count what got through.
 */
async function sampleInboundAudio(page: Page, peaks: Map<string, number>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const [stream, bytes] of Object.entries(await inboundAudioByStream(page))) {
      peaks.set(stream, Math.max(peaks.get(stream) ?? 0, bytes));
    }
    await page.waitForTimeout(250);
  }
}

function totalPeakBytes(peaks: Map<string, number>): number {
  let total = 0;
  for (const bytes of peaks.values()) total += bytes;
  return total;
}

type PublishAttempt =
  | 'microphone'
  | 'camera'
  | 'screen-share'
  | 'audio-as-camera'
  | 'audio-as-screen-share'
  | 'audio-as-screen-share-audio';

/**
 * Try to publish one track from the page and report what happened:
 * "accepted", "rejected: <error>" or "no answer". A screen share falls back
 * to a canvas track labelled ScreenShare when the headless browser offers
 * no screen to capture (the grant is what is being tested).
 */
async function tryPublish(page: Page, what: PublishAttempt): Promise<string> {
  return page.evaluate(async (what) => {
    const LK = window.LivekitClient;
    const lp = window.__room.localParticipant;
    const withTimeout = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer within 15s')), 15_000))]);
    const micTrack = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return stream.getAudioTracks()[0]!;
    };
    try {
      switch (what) {
        case 'microphone':
          await withTimeout(lp.setMicrophoneEnabled(true));
          break;
        case 'camera':
          await withTimeout(lp.setCameraEnabled(true));
          break;
        case 'screen-share':
          try {
            await withTimeout(lp.setScreenShareEnabled(true, { audio: false }));
          } catch (err) {
            const message = String((err as Error)?.message ?? err);
            // Only a capture failure falls back — a refusal by LiveKit is the answer.
            if (!/notallowed|notsupported|not supported|notfound|abort|could not start|getDisplayMedia/i.test(message)) throw err;
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 180;
            const ctx2d = canvas.getContext('2d')!;
            setInterval(() => {
              ctx2d.fillStyle = `hsl(${Date.now() % 360}, 70%, 50%)`;
              ctx2d.fillRect(0, 0, 320, 180);
            }, 100);
            const video = canvas.captureStream(10).getVideoTracks()[0]!;
            await withTimeout(lp.publishTrack(video, { source: LK.Track.Source.ScreenShare, name: 'canvas-screen' }));
            return 'accepted (canvas fallback: ' + message + ')';
          }
          break;
        case 'audio-as-camera':
          await withTimeout(lp.publishTrack(await micTrack(), { source: LK.Track.Source.Camera, name: 'audio-as-camera' }));
          break;
        case 'audio-as-screen-share':
          await withTimeout(
            lp.publishTrack(await micTrack(), { source: LK.Track.Source.ScreenShare, name: 'audio-as-screen' })
          );
          break;
        case 'audio-as-screen-share-audio':
          await withTimeout(
            lp.publishTrack(await micTrack(), { source: LK.Track.Source.ScreenShareAudio, name: 'audio-as-screen-audio' })
          );
          break;
      }
      return 'accepted';
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      return message.startsWith('no answer') ? message : 'rejected: ' + message;
    }
  }, what);
}

// ── The suite ──────────────────────────────────────────────────────────

test.describe('security review 2026-10 — regressions on the real stack', () => {
  let owner: APIRequestContext;
  let ownerUid = '';
  let serverId = '';
  let textChannelId = '';
  let everyoneRoleId = '';
  /** A multi-use invite the owner made; members join through it. */
  let inviteCode = '';

  test.beforeAll(async ({ playwright }) => {
    owner = await newApi(playwright);
    // Fresh stack → first-run setup; warm stack → owner login.
    const setup = await owner.post('/api/setup/complete', {
      data: {
        setupToken,
        instanceName: 'Security Review E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await send(() =>
        owner.post('/api/auth/login', { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } })
      );
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    const me = (await (await owner.get('/api/auth/guest')).json()) as { guest: { uid: string } };
    ownerUid = me.guest.uid;

    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    textChannelId = channels.find((c) => c.type === 'text')!.id;
    const { roles } = (await (await owner.get(`/api/servers/${serverId}/roles`)).json()) as {
      roles: Array<{ id: string; name: string; position: number }>;
    };
    everyoneRoleId = roles.filter((r) => r.name === '@everyone').sort((a, b) => a.position - b.position)[0]!.id;

    const invite = await send(() => owner.post(`/api/servers/${serverId}/invites`, { data: { maxUses: 1000 } }));
    expect(invite.status()).toBe(201);
    inviteCode = ((await invite.json()) as { invite: { code: string } }).invite.code;
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  /** Redeem the owner's invite; the redeem route takes no body. */
  async function join(member: Member) {
    const res = await send(() => member.api.post(`/api/invites/${inviteCode}/redeem`));
    expect(res.status(), `${member.name} joins`).toBe(201);
  }

  async function memberChannelIds(member: Member): Promise<string[]> {
    const res = await member.api.get(`/api/servers/${serverId}/channels`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { channels: Array<{ id: string }> }).channels.map((c) => c.id);
  }

  async function createChannel(name: string, type: 'text' | 'voice'): Promise<string> {
    const res = await send(() => owner.post(`/api/servers/${serverId}/channels`, { data: { name, type } }));
    expect(res.status(), `create channel ${name}`).toBe(201);
    return ((await res.json()) as { channel: { id: string } }).channel.id;
  }

  async function deleteChannel(channelId: string) {
    await send(() => owner.delete(`/api/servers/${serverId}/channels/${channelId}`)).catch(() => undefined);
  }

  async function createRole(name: string, permissions: string[]): Promise<string> {
    const res = await send(() => owner.post(`/api/servers/${serverId}/roles`, { data: { name, permissions } }));
    expect(res.status(), `create role ${name}`).toBe(201);
    return ((await res.json()) as { role: { id: string } }).role.id;
  }

  async function giveRole(member: Member, roleId: string) {
    const res = await send(() =>
      owner.put(`/api/servers/${serverId}/members/${member.uid}/role`, { data: { roleIds: [everyoneRoleId, roleId] } })
    );
    expect(res.status(), `assign role to ${member.name}`).toBe(200);
  }

  async function postMessage(member: Member, content: string) {
    return send(() =>
      member.api.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, { data: { content } })
    );
  }

  async function auditLogs(limit = 100) {
    const res = await owner.get(`/api/servers/${serverId}/audit-logs?limit=${limit}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as {
      auditLogs: Array<{ action: string; actorUserId: string | null; targetId: string | null; metadata: Record<string, unknown> }>;
    }).auditLogs;
  }

  async function voiceToken(member: { api: APIRequestContext }, channelId: string) {
    const res = await send(() => member.api.post('/api/livekit/token', { data: { serverId, channelId } }));
    expect(res.status(), 'voice token').toBe(200);
    return (await res.json()) as { token: string; livekitUrl: string; identity: string };
  }

  // ── Accounts and sessions ────────────────────────────────────────────

  test('AUTH-002: two session cookies are refused; a signed-out cookie no longer renders the lobby', async ({
    playwright,
  }) => {
    const alice = await newGuest(playwright, 'Twocookie');
    const bob = await newGuest(playwright, 'Othercookie');
    await join(alice);
    const aliceCookie = `lf_guest=${await sessionCookie(alice.api)}`;
    const bobCookie = `lf_guest=${await sessionCookie(bob.api)}`;

    // One cookie: fine. Two (whichever order): refused before anything reads either.
    expect((await rawRequest('/api/servers', aliceCookie)).status).toBe(200);
    for (const header of [`${aliceCookie}; ${bobCookie}`, `${bobCookie}; ${aliceCookie}`]) {
      const dup = await rawRequest('/api/servers', header);
      expect(dup.status).toBe(400);
      expect(await dup.json()).toMatchObject({ error: 'Duplicate session cookie' });
    }

    // The cookie renders the lobby while the session is live…
    const before = await rawRequest(`/lobby?server=${serverId}`, aliceCookie);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('Voice Channels');

    // …and after sign-out the SAME value is sent away, on pages and APIs alike.
    expect((await send(() => alice.api.post('/api/auth/logout'))).status()).toBe(200);
    const after = await rawRequest(`/lobby?server=${serverId}`, aliceCookie);
    expect(after.status).toBe(307);
    expect(new URL(after.headers.get('location') ?? '', baseUrl).pathname).toBe('/login');
    expect((await rawRequest('/api/servers', aliceCookie)).status).toBe(401);

    await alice.api.dispose();
    await bob.api.dispose();
  });

  test('AUTH-001: a desktop sign-in code minted before a password change does not complete after it', async ({
    playwright,
  }) => {
    const email = `sec-${RUN}-${Math.random().toString(36).slice(2, 8)}@e2e.local`;
    const firstPassword = `first-password-${RUN}`;
    const secondPassword = `second-password-${RUN}`;
    const user = await newApi(playwright);
    // With the owner's invite: registration works whatever the access policy.
    const register = await send(() =>
      user.post('/api/auth/register', {
        data: { email, displayName: `Desk ${RUN.slice(-4)}`, password: firstPassword, inviteCode },
      })
    );
    expect(register.status(), await register.text()).toBe(201);

    // Minting sets no cookie, so this context stays signed out.
    const minter = await newApi(playwright);
    const mint = async () => {
      const res = await send(() => minter.post('/api/auth/desktop-session', { data: { email, password: firstPassword } }));
      expect(res.status()).toBe(200);
      return (await res.json()) as { code: string; state: string };
    };
    // Each completion from a context with no cookie at all: a session the
    // password change revoked must not be what answers 401 here.
    const complete = async (code: { code: string; state: string }) => {
      const shell = await newApi(playwright);
      const res = await send(() => shell.post('/api/auth/desktop-session/complete', { data: code }));
      const result = { status: res.status(), body: await res.text(), setCookie: res.headers()['set-cookie'] ?? '' };
      await shell.dispose();
      return result;
    };

    // Control: a code completes while the password is unchanged.
    const control = await complete(await mint());
    expect(control.status, control.body).toBe(200);
    expect(control.setCookie).toContain('lf_guest=');

    const stale = await mint();
    const change = await send(() =>
      user.post('/api/auth/password', { data: { currentPassword: firstPassword, newPassword: secondPassword } })
    );
    expect(change.status(), await change.text()).toBe(200);
    const late = await complete(stale);
    expect(late.status).toBe(401);
    expect(JSON.parse(late.body)).toEqual({ error: 'Handoff code expired or invalid.' });
    expect(late.setCookie).not.toContain('lf_guest=');

    await user.dispose();
    await minter.dispose();
  });

  // ── Communities and moderation ───────────────────────────────────────

  test('AUTHZ-001: deleting the last role that gates a channel is refused and the channel stays hidden', async ({
    playwright,
  }) => {
    const member = await newGuest(playwright, 'Plain');
    await join(member);
    const roleId = await createRole(`Gate ${RUN}`, []);
    const channelId = await createChannel(`gated-${RUN}`, 'text');
    try {
      const gate = await send(() =>
        owner.patch(`/api/servers/${serverId}/channels/${channelId}`, { data: { visibleToRoleIds: [roleId] } })
      );
      expect(gate.status()).toBe(200);
      expect(await memberChannelIds(member)).not.toContain(channelId);

      const del = await send(() => owner.delete(`/api/servers/${serverId}/roles/${roleId}`));
      expect(del.status()).toBe(409);
      const body = (await del.json()) as { code: string; channels: unknown[] };
      expect(body.code).toBe('role_gates_channels');
      expect(JSON.stringify(body.channels)).toContain(channelId);

      // Nothing was deleted: the role is still there, the channel still hidden.
      expect((await owner.get(`/api/servers/${serverId}/roles/${roleId}`)).status()).toBe(200);
      expect(await memberChannelIds(member)).not.toContain(channelId);
      expect([403, 404]).toContain((await member.api.get(`/api/servers/${serverId}/channels/${channelId}`)).status());
    } finally {
      await deleteChannel(channelId);
      // With the channel gone the role gates nothing and deletes normally.
      const cleanup = await send(() => owner.delete(`/api/servers/${serverId}/roles/${roleId}`));
      expect(cleanup.status()).toBe(200);
      await member.api.dispose();
    }
  });

  test('AUTHZ-002: a timeout survives leaving and rejoining; timed-out members cannot invite; leavers can be banned', async ({
    playwright,
  }) => {
    const member = await newGuest(playwright, 'Timeout');
    await join(member);
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const timeout = await send(() =>
      owner.put(`/api/servers/${serverId}/members/${member.uid}/timeout`, { data: { until } })
    );
    expect(timeout.status()).toBe(200);

    const silenced = await postMessage(member, `still here? ${RUN}`);
    expect(silenced.status()).toBe(403);
    expect(((await silenced.json()) as { error: string }).error).toBe(TIMED_OUT);
    // A timed-out member mints no invite (the first step of the old escape).
    const ownInvite = await send(() => member.api.post(`/api/servers/${serverId}/invites`, { data: {} }));
    expect(ownInvite.status()).toBe(403);
    expect(((await ownInvite.json()) as { error: string }).error).toBe(TIMED_OUT);

    // Leave, then come back through the owner's invite: still timed out.
    const leave = await send(() => member.api.delete(`/api/servers/${serverId}/members/${member.uid}`));
    expect(leave.status()).toBe(200);
    await join(member);
    const afterRejoin = await postMessage(member, `free again? ${RUN}`);
    expect(afterRejoin.status()).toBe(403);
    expect(((await afterRejoin.json()) as { error: string }).error).toBe(TIMED_OUT);
    expect((await send(() => member.api.post(`/api/servers/${serverId}/invites`, { data: {} }))).status()).toBe(403);

    // Someone who already left can still be banned, and the ban holds.
    const leaver = await newGuest(playwright, 'Leaver');
    await join(leaver);
    expect((await send(() => leaver.api.delete(`/api/servers/${serverId}/members/${leaver.uid}`))).status()).toBe(200);
    const ban = await send(() =>
      owner.post(`/api/servers/${serverId}/bans`, { data: { userId: leaver.uid, reason: `security e2e ${RUN}` } })
    );
    expect(ban.status(), await ban.text()).toBe(201);
    expect((await send(() => leaver.api.post(`/api/invites/${inviteCode}/redeem`))).status()).toBe(403);

    await member.api.dispose();
    await leaver.api.dispose();
  });

  test('AUTHZ-003: Manage Messages can pin and delete a message, but only its author can change the text', async ({
    playwright,
  }) => {
    const author = await newGuest(playwright, 'Author');
    const moderator = await newGuest(playwright, 'Moderator');
    await join(author);
    await join(moderator);
    const roleId = await createRole(`Mods ${RUN}`, ['manage_messages']);
    try {
      await giveRole(moderator, roleId);
      const posted = await postMessage(author, `original words ${RUN}`);
      expect(posted.status()).toBe(201);
      const messageId = ((await posted.json()) as { message: { id: string } }).message.id;
      const messageUrl = `/api/servers/${serverId}/channels/${textChannelId}/messages/${messageId}`;

      const rewrite = await send(() => moderator.api.patch(messageUrl, { data: { content: `words put in a mouth ${RUN}` } }));
      expect(rewrite.status()).toBe(403);
      expect(await rewrite.json()).toMatchObject({ code: 'not_message_author' });
      const unchanged = (await (await author.api.get(messageUrl)).json()) as { message: { content: string; editedAt: string | null } };
      expect(unchanged.message.content).toBe(`original words ${RUN}`);
      expect(unchanged.message.editedAt).toBeNull();

      // The author still can.
      expect((await send(() => author.api.patch(messageUrl, { data: { content: `my own edit ${RUN}` } }))).status()).toBe(200);
      // The moderator keeps pin and delete.
      const pin = await send(() => moderator.api.patch(messageUrl, { data: { pinned: true } }));
      expect(pin.status()).toBe(200);
      const del = await send(() => moderator.api.delete(messageUrl));
      expect(del.status()).toBe(200);
    } finally {
      await send(() => owner.delete(`/api/servers/${serverId}/roles/${roleId}`));
      await author.api.dispose();
      await moderator.api.dispose();
    }
  });

  test('AUTHZ-004: with approval required for a first join, an invite cannot be redeemed', async ({ playwright }) => {
    const policyUrl = `/api/servers/${serverId}/access-policy`;
    const current = ((await (await owner.get(policyUrl)).json()) as {
      accessPolicy: {
        joinPolicy: string;
        externalIdentity: string;
        localAccount: string;
        accountLinking: string;
        requireApprovalForFirstJoin: boolean;
      };
    }).accessPolicy;
    const original = {
      joinPolicy: current.joinPolicy,
      externalIdentity: current.externalIdentity,
      localAccount: current.localAccount,
      accountLinking: current.accountLinking,
      requireApprovalForFirstJoin: current.requireApprovalForFirstJoin,
    };
    const newcomer = await newGuest(playwright, 'Newcomer');
    const newcomerCookie = `lf_guest=${await sessionCookie(newcomer.api)}`;
    try {
      const strict = await send(() => owner.patch(policyUrl, { data: { ...original, requireApprovalForFirstJoin: true } }));
      expect(strict.status()).toBe(200);

      const redeem = await send(() => newcomer.api.post(`/api/invites/${inviteCode}/redeem`));
      expect(redeem.status()).toBe(403);
      expect(await redeem.json()).toMatchObject({ code: 'approval_required' });
      // The lobby's auto-join refuses too — and says so, not "data unavailable".
      const lobby = await rawRequest('/lobby', newcomerCookie);
      expect(lobby.status).toBe(200);
      expect(await lobby.text()).toContain('Ask one of its moderators for an invite or for approval.');
      expect((await newcomer.api.get('/api/servers')).status()).toBe(200);
      const { servers } = (await (await newcomer.api.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
      expect(servers.map((s) => s.id)).not.toContain(serverId);
    } finally {
      const restore = await send(() => owner.patch(policyUrl, { data: original }));
      expect(restore.status(), 'access policy restored').toBe(200);
    }
    // Policy back: the same invite works again.
    await join(newcomer);
    await newcomer.api.dispose();
  });

  /**
   * A member with a freshly uploaded 256×256 PNG avatar ("pictured") and a
   * second member who looks at them ("viewer").
   */
  async function withPicturedMember(
    playwright: Playwright,
    body: (ctx: {
      pictured: Member;
      viewer: Member;
      png: Buffer;
      avatarPath: string;
      /** The viewer's /lobby HTML. */
      lobbyHtml: () => Promise<string>;
      /** The avatar version token the viewer's lobby links. */
      linkedVersion: () => Promise<string>;
      /** The pictured member switches "Profile visibility" to Nobody. */
      hideProfile: () => Promise<void>;
    }) => Promise<void>
  ) {
    const pictured = await newGuest(playwright, 'Pictured');
    const viewer = await newGuest(playwright, 'Viewer');
    try {
      await join(pictured);
      await join(viewer);
      const png = solidPng(256, [0x2a, 0x9d, 0x8f]);
      const upload = await send(() =>
        pictured.api.post('/api/users/me/avatar', { data: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } })
      );
      expect(upload.status(), await upload.text()).toBe(200);
      const avatarPath = `/api/users/${pictured.uid}/avatar`;
      const lobbyHtml = async () => {
        const res = await viewer.api.get(`/lobby?server=${serverId}`, { maxRedirects: 0 });
        expect(res.status()).toBe(200);
        return res.text();
      };
      const linkedVersion = async () => {
        const version = new RegExp(`${escapeRegExp(avatarPath)}\\?v=([0-9a-f]+)`).exec(await lobbyHtml())?.[1];
        expect(version, 'the lobby links the avatar with a version').toBeTruthy();
        return version!;
      };
      const hideProfile = async () => {
        const settings = (await (await pictured.api.get('/api/settings/me')).json()) as {
          settings: { privacy: Record<string, unknown> };
        };
        const hide = await send(() =>
          pictured.api.patch('/api/settings/me', {
            data: { privacy: { ...settings.settings.privacy, profileVisibility: 'nobody' } },
          })
        );
        expect(hide.status()).toBe(200);
      };
      await body({ pictured, viewer, png, avatarPath, lobbyHtml, linkedVersion, hideProfile });
    } finally {
      await pictured.api.dispose();
      await viewer.api.dispose();
    }
  }

  test('AUTHZ-005 / FILE-001: the lobby links avatars by short URL, never a data URL, and "nobody" removes the link', async ({
    playwright,
  }) => {
    await withPicturedMember(playwright, async ({ pictured, avatarPath, lobbyHtml, hideProfile }) => {
      // The member list links the image; no data URL rides along.
      const html = await lobbyHtml();
      expect(html).toContain(pictured.name);
      expect(html).toMatch(new RegExp(`${escapeRegExp(avatarPath)}\\?v=[0-9a-f]{6,32}`));
      expect(html).not.toContain('data:image');

      // "Profile visibility: nobody" — the viewer keeps the name, loses the picture.
      await hideProfile();
      const hiddenHtml = await lobbyHtml();
      expect(hiddenHtml).toContain(pictured.name);
      expect(hiddenHtml).not.toContain(avatarPath);
    });
  });

  test('AUTHZ-005 / FILE-001: the avatar route serves the PNG with nosniff, and 404s once the profile is hidden', async ({
    playwright,
  }) => {
    // Found by this spec on 2026-10-03: every GET /api/users/<id>/avatar|banner
    // answered 500 — `getUserImageAccess` (packages/db/src/queries/userImages.ts)
    // rendered `users.id` as a bare "id", ambiguous inside the user_settings /
    // memberships subqueries. It now passes the subject id as a parameter.
    await withPicturedMember(playwright, async ({ pictured, viewer, png, avatarPath, linkedVersion, hideProfile }) => {
      const version = await linkedVersion();
      const image = await viewer.api.get(`${avatarPath}?v=${version}`);
      expect(image.status()).toBe(200);
      expect(image.headers()['content-type']).toBe('image/png');
      expect(image.headers()['x-content-type-options']).toBe('nosniff');
      expect(image.headers()['cache-control']).toContain('private');
      expect(Buffer.compare(await image.body(), png)).toBe(0);

      await hideProfile();
      expect((await viewer.api.get(`${avatarPath}?v=${version}`)).status()).toBe(404);
      // The owner of the picture always sees it.
      expect((await pictured.api.get(`${avatarPath}?v=${version}`)).status()).toBe(200);
    });
  });

  // ── Voice publish grants on the real LiveKit (AUTHZ-006) ─────────────

  test('AUTHZ-006: a member still publishes microphone, camera and screen share', async ({ playwright, browser }) => {
    const speaker = await newGuest(playwright, 'Speaker');
    await join(speaker);
    const channelId = await createChannel(`sec-voice-${RUN}-a`, 'voice');
    const pages: BrowserContext[] = [];
    try {
      const ownerToken = await voiceToken({ api: owner }, channelId);
      const speakerToken = await voiceToken(speaker, channelId);
      const grant = videoGrant(speakerToken.token);
      expect(grant.canPublish).toBe(true);
      expect([...(grant.canPublishSources ?? [])].sort()).toEqual(
        ['camera', 'microphone', 'screen_share', 'screen_share_audio'].sort()
      );

      const listener = await openLiveKitPage(browser);
      const talker = await openLiveKitPage(browser);
      pages.push(listener.ctx, talker.ctx);
      await connectRoom(listener.page, ownerToken.livekitUrl, ownerToken.token);
      await connectRoom(talker.page, speakerToken.livekitUrl, speakerToken.token);

      const results = {
        microphone: await tryPublish(talker.page, 'microphone'),
        camera: await tryPublish(talker.page, 'camera'),
        screenShare: await tryPublish(talker.page, 'screen-share'),
      };
      console.info('[livekit] member publish results', results);
      expect(results.microphone).toBe('accepted');
      expect(results.camera).toBe('accepted');
      expect(results.screenShare).toMatch(/^accepted/);

      // The other side receives all three.
      await expect
        .poll(async () => (await subscriptionsFrom(listener.page, speakerToken.identity)).map((e) => `${e.source}:${e.kind}`).sort(), {
          timeout: 30_000,
        })
        .toEqual(['camera:video', 'microphone:audio', 'screen_share:video']);
      await expect.poll(() => inboundAudioBytes(listener.page), { timeout: 20_000 }).toBeGreaterThan(0);
    } finally {
      for (const ctx of pages) await ctx.close();
      await deleteChannel(channelId);
      await speaker.api.dispose();
    }
  });

  /**
   * A server-muted member (the talker) and the owner (the listener), both
   * connected through the real LiveKit to a fresh voice room. Checks the
   * grant the token route gives a server-muted member before handing over.
   */
  async function withServerMutedTalker(
    playwright: Playwright,
    browser: Browser,
    suffix: string,
    body: (room: {
      listener: Page;
      talker: Page;
      identity: string;
      /** The talker fetches a fresh token and connects again (after a removal). */
      rejoinTalker: () => Promise<void>;
    }) => Promise<void>
  ) {
    const muted = await newGuest(playwright, 'Muted');
    await join(muted);
    const channelId = await createChannel(`sec-voice-${RUN}-${suffix}`, 'voice');
    const pages: BrowserContext[] = [];
    const muteUrl = `/api/servers/${serverId}/channels/${channelId}/members/${muted.uid}/voice/mute`;
    try {
      const mute = await send(() => owner.post(muteUrl, { data: { muted: true } }));
      expect(mute.status(), await mute.text()).toBe(200);

      const ownerToken = await voiceToken({ api: owner }, channelId);
      const mutedToken = await voiceToken(muted, channelId);
      const grant = videoGrant(mutedToken.token);
      // A server mute is about sound: no microphone, no screen-share audio.
      expect(grant.canPublish).toBe(true);
      expect([...(grant.canPublishSources ?? [])].sort()).toEqual(['camera', 'screen_share']);

      const listener = await openLiveKitPage(browser);
      const talker = await openLiveKitPage(browser);
      pages.push(listener.ctx, talker.ctx);
      await connectRoom(listener.page, ownerToken.livekitUrl, ownerToken.token);
      await connectRoom(talker.page, mutedToken.livekitUrl, mutedToken.token);
      const rejoinTalker = async () => {
        const fresh = await voiceToken(muted, channelId);
        await connectRoom(talker.page, fresh.livekitUrl, fresh.token);
      };
      await body({ listener: listener.page, talker: talker.page, identity: mutedToken.identity, rejoinTalker });
    } finally {
      for (const ctx of pages) await ctx.close();
      await send(() => owner.post(muteUrl, { data: { muted: false } })).catch(() => undefined);
      await deleteChannel(channelId);
      await muted.api.dispose();
    }
  }

  test('AUTHZ-006: a server-muted member loses microphone and screen audio, and keeps camera and screen share', async ({
    playwright,
    browser,
  }) => {
    await withServerMutedTalker(playwright, browser, 'b', async ({ listener, talker, identity }) => {
      const results = {
        camera: await tryPublish(talker, 'camera'),
        screenShare: await tryPublish(talker, 'screen-share'),
        microphone: await tryPublish(talker, 'microphone'),
        screenShareAudio: await tryPublish(talker, 'audio-as-screen-share-audio'),
      };
      console.info('[livekit] server-muted member publish results', results);
      expect(results.camera).toBe('accepted');
      expect(results.screenShare).toMatch(/^accepted/);
      // Refused by LiveKit itself, not merely unanswered.
      expect(results.microphone).toMatch(/^rejected: .*insufficient permissions/);
      expect(results.screenShareAudio).toMatch(/^rejected: .*insufficient permissions/);

      await expect
        .poll(async () => (await subscriptionsFrom(listener, identity)).map((e) => `${e.source}:${e.kind}`).sort(), {
          timeout: 20_000,
        })
        .toEqual(['camera:video', 'screen_share:video']);
      await talker.waitForTimeout(3_000);
      expect(await inboundAudioBytes(listener)).toBe(0);
    });
  });

  test('AUTHZ-006: a server-muted member who publishes audio labelled camera or screen share is removed before the room hears it', async ({
    playwright,
    browser,
  }) => {
    // Found by this spec on 2026-10-03 (LiveKit v1.13.7): LiveKit checks only
    // the SOURCE a new track claims against canPublishSources, never that a
    // Camera / ScreenShare track is video. A server-muted member keeps camera
    // + screen share (by design), so their microphone published with
    // `source: Camera` (or ScreenShare) was accepted and the room heard them
    // (~82 KB of audio in 5 s). The same hole let a role with STREAM but no
    // SPEAK talk. Fixed in two layers: the app's own listeners never
    // subscribe to a track whose kind does not match its source
    // (lib/voice-track-policy.ts), and LiveKit's track_published webhook has
    // the server remove the publisher (app/api/livekit/webhook).
    //
    // This listener is a RAW livekit-client with autoSubscribe — no app
    // filter — so what it receives is exactly what the server lets through:
    // the moment between the publish and the removal, nothing more.
    await withServerMutedTalker(playwright, browser, 'c', async ({ listener, talker, identity, rejoinTalker }) => {
      const peaks = new Map<string, number>();
      const rounds: Array<{ attempt: PublishAttempt; result: string; leakedBytes: number }> = [];
      for (const attempt of ['audio-as-camera', 'audio-as-screen-share'] as const) {
        if (rounds.length > 0) {
          // Removal is not a ban: the member may come back — and is removed again.
          await rejoinTalker();
          await expect
            .poll(() => listener.evaluate((id) => window.__room.remoteParticipants.has(id), identity), { timeout: 20_000 })
            .toBe(true);
        }
        const before = totalPeakBytes(peaks);
        const result = await tryPublish(talker, attempt);
        await sampleInboundAudio(listener, peaks, 6_000);
        const leakedBytes = totalPeakBytes(peaks) - before;
        rounds.push({ attempt, result, leakedBytes });

        // LiveKit still ACCEPTS the mislabelled source (should it ever refuse
        // it, even better); once accepted, the server must remove the talker.
        if (result === 'accepted') {
          await expect
            .poll(() => talker.evaluate(() => window.__room.state as string), { timeout: 15_000 })
            .toBe('disconnected');
          await expect
            .poll(() => listener.evaluate((id) => window.__room.remoteParticipants.has(id), identity), { timeout: 15_000 })
            .toBe(false);
        }
        // At most a moment of audio — far below a talk-around.
        expect(leakedBytes, `${attempt}: inbound audio bytes at the listener`).toBeLessThan(MAX_LEAKED_AUDIO_BYTES);
      }

      const received = await subscriptionsFrom(listener, identity);
      console.info('[livekit] server-muted member, audio under other sources:', rounds, 'listener subscribed to', received);
      test.info().annotations.push({
        type: 'livekit result',
        description: JSON.stringify({ rounds, received }),
      });
    });
  });

  test('AUTHZ-006: a timed-out member gets canPublish:false and LiveKit refuses every source', async ({
    playwright,
    browser,
  }) => {
    const quiet = await newGuest(playwright, 'Quiet');
    await join(quiet);
    const channelId = await createChannel(`sec-voice-${RUN}-d`, 'voice');
    const pages: BrowserContext[] = [];
    try {
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      expect(
        (await send(() => owner.put(`/api/servers/${serverId}/members/${quiet.uid}/timeout`, { data: { until } }))).status()
      ).toBe(200);
      const ownerToken = await voiceToken({ api: owner }, channelId);
      const quietToken = await voiceToken(quiet, channelId);
      const grant = videoGrant(quietToken.token);
      // LiveKit reads an empty list as "everything": the flag must say no.
      expect(grant.canPublish).toBe(false);
      expect(grant.canPublishSources ?? []).toEqual([]);

      const listener = await openLiveKitPage(browser);
      const talker = await openLiveKitPage(browser);
      pages.push(listener.ctx, talker.ctx);
      await connectRoom(listener.page, ownerToken.livekitUrl, ownerToken.token);
      await connectRoom(talker.page, quietToken.livekitUrl, quietToken.token);
      const results = {
        microphone: await tryPublish(talker.page, 'microphone'),
        camera: await tryPublish(talker.page, 'camera'),
        screenShare: await tryPublish(talker.page, 'screen-share'),
      };
      await talker.page.waitForTimeout(3_000);
      const received = await subscriptionsFrom(listener.page, quietToken.identity);
      console.info('[livekit] timed-out member publish results', results, 'listener received', received);
      expect(results.microphone).not.toBe('accepted');
      expect(results.camera).not.toBe('accepted');
      expect(results.screenShare).not.toMatch(/^accepted/);
      expect(received).toEqual([]);
    } finally {
      for (const ctx of pages) await ctx.close();
      await deleteChannel(channelId);
      await quiet.api.dispose();
    }
  });

  // ── Activities and plugins ───────────────────────────────────────────

  test('PLUG-001: a poll vote is not written to the audit log (host actions still are)', async ({ playwright }) => {
    const voter = await newGuest(playwright, 'Voter');
    await join(voter);
    expect((await send(() => owner.post(`/api/servers/${serverId}/apps`, { data: { pluginId: 'poll', enabled: true } }))).status()).toBe(200);
    const channelId = await createChannel(`sec-poll-${RUN}`, 'voice');
    let sessionId = '';
    try {
      const created = await send(() =>
        owner.post(`/api/servers/${serverId}/channels/${channelId}/activities`, { data: { pluginId: 'poll' } })
      );
      expect(created.status()).toBe(201);
      sessionId = ((await created.json()) as { activity: { id: string } }).activity.id;
      const act = (api: APIRequestContext, body: Record<string, unknown>) =>
        send(() => api.post(`/api/servers/${serverId}/activities/${sessionId}/actions`, { data: body }));

      const opened = await act(owner, {
        type: 'open-poll',
        hostId: ownerUid,
        question: `Secret ballot ${RUN}?`,
        options: ['Yes', 'No'],
      });
      expect(opened.status()).toBe(200);
      const options = ((await opened.json()) as { activity: { state: { options: Array<{ id: string }> } } }).activity.state
        .options;
      const vote = await act(voter.api, { type: 'vote', playerId: voter.uid, optionId: options[0]!.id });
      expect(vote.status()).toBe(200);
      const tally = ((await vote.json()) as { activity: { state: { options: Array<{ votes: number }>; ballotCount: number } } })
        .activity.state;
      expect(tally.ballotCount).toBe(1);
      // A host action AFTER the vote: once its row is in, any vote row would be too.
      expect((await act(owner, { type: 'close-poll', hostId: ownerUid })).status()).toBe(200);

      const sessionRows = async () =>
        (await auditLogs(200)).filter((e) => e.action === 'activity.action' && e.targetId === sessionId);
      await expect
        .poll(async () => (await sessionRows()).map((e) => e.metadata.actionType).sort(), { timeout: 10_000 })
        .toEqual(['close-poll', 'open-poll']);
      const rows = await sessionRows();
      expect(rows.some((e) => e.metadata.actionType === 'vote')).toBe(false);
      expect(rows.some((e) => e.actorUserId === voter.uid)).toBe(false);
    } finally {
      if (sessionId) await send(() => owner.post(`/api/servers/${serverId}/activities/${sessionId}/end`, { data: {} }));
      await deleteChannel(channelId);
      await voter.api.dispose();
    }
  });

  test('PLUG-002: a host who was kicked cannot end their activity', async ({ playwright }) => {
    const host = await newGuest(playwright, 'Host');
    await join(host);
    expect((await send(() => owner.post(`/api/servers/${serverId}/apps`, { data: { pluginId: 'poll', enabled: true } }))).status()).toBe(200);
    const roleId = await createRole(`Hosts ${RUN}`, ['start_activity']);
    const channelId = await createChannel(`sec-host-${RUN}`, 'voice');
    let sessionId = '';
    try {
      await giveRole(host, roleId);
      const created = await send(() =>
        host.api.post(`/api/servers/${serverId}/channels/${channelId}/activities`, { data: { pluginId: 'poll' } })
      );
      expect(created.status()).toBe(201);
      sessionId = ((await created.json()) as { activity: { id: string } }).activity.id;

      const kick = await send(() => owner.delete(`/api/servers/${serverId}/members/${host.uid}`));
      expect(kick.status()).toBe(200);
      const end = await send(() => host.api.post(`/api/servers/${serverId}/activities/${sessionId}/end`, { data: {} }));
      expect(end.status()).toBe(403);
      // Still open: the kicked host changed nothing.
      const still = await owner.get(`/api/servers/${serverId}/activities/${sessionId}`);
      expect(still.status()).toBe(200);
      expect(((await still.json()) as { activity: { status: string } }).activity.status).not.toMatch(/ended|cancelled/);
    } finally {
      if (sessionId) {
        const ended = await send(() => owner.post(`/api/servers/${serverId}/activities/${sessionId}/end`, { data: {} }));
        expect(ended.status(), 'the owner can still end it').toBe(200);
      }
      await deleteChannel(channelId);
      await send(() => owner.delete(`/api/servers/${serverId}/roles/${roleId}`));
      await host.api.dispose();
    }
  });

  // ── Directory ────────────────────────────────────────────────────────

  test('FILE-002 / HUB-001: directory writes are official-hub only; the install has its own directory id', async ({
    playwright,
  }) => {
    const challenge = await owner.get(
      '/api/directory/register/challenge?instanceId=00000000-0000-4000-8000-000000000001&domain=https%3A%2F%2Fexample.com'
    );
    expect(challenge.status()).toBe(404);
    const register = await owner.post('/api/directory/register', { data: {} });
    expect(register.status()).toBe(404);

    const config = await owner.get('/api/admin/directory/config');
    expect(config.status()).toBe(200);
    const { config: directory } = (await config.json()) as { config: { instanceId: string } };
    expect(directory.instanceId).toMatch(UUID_RE);
    expect(directory.instanceId).not.toBe('self-host');

    // Positive control on an official-mode web of the same stack: the route exists there.
    if (officialUrl) {
      const official = await playwright.request.newContext({ baseURL: officialUrl, extraHTTPHeaders: { Origin: officialUrl } });
      const there = await official.get('/api/directory/register/challenge?instanceId=x&domain=y');
      expect(there.status()).not.toBe(404);
      await official.dispose();
    }
  });
});
