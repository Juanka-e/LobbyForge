/**
 * Real-UI voice E2E: two users drive the ACTUAL lobby UI (not a synthetic
 * livekit-client harness) and we measure that audio really flows, using
 * the browsers' own WebRTC stats (inbound-rtp bytes + totalAudioEnergy).
 *
 * Covers: join via the voice channel button, bidirectional audio, local
 * mute, deafen, moderator (server) mute + client-side unmute attempt,
 * page-reload rejoin, and realtime chat delivery through the ws-gateway.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL) whose web image was
 * built with NEXT_PUBLIC_LIVEKIT_URL / NEXT_PUBLIC_WS_URL pointing at the
 * stack's own LiveKit and gateway ports.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

type AudioStats = { bytes: number; packets: number; energy: number; streams: number };

declare global {
  interface Window {
    __pcs: RTCPeerConnection[];
  }
}

/** Track every RTCPeerConnection the app creates so we can read its stats. */
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

type StreamSample = { bytes: number; packets: number; energy: number };

/** inbound-rtp audio counters per stats id (a stream replaced mid-window restarts at 0). */
async function inboundAudioStreams(page: Page): Promise<Record<string, StreamSample>> {
  return page.evaluate(async () => {
    const out: Record<string, { bytes: number; packets: number; energy: number }> = {};
    const pcs = window.__pcs ?? [];
    for (let i = 0; i < pcs.length; i += 1) {
      const pc = pcs[i]!;
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          out[`${i}:${String(s.id)}`] = {
            bytes: Number(s.bytesReceived ?? 0),
            packets: Number(s.packetsReceived ?? 0),
            energy: Number(s.totalAudioEnergy ?? 0),
          };
        }
      });
    }
    return out;
  });
}

async function inboundAudio(page: Page): Promise<AudioStats> {
  const streams = await inboundAudioStreams(page);
  const out = { bytes: 0, packets: 0, energy: 0, streams: 0 };
  for (const sample of Object.values(streams)) {
    out.bytes += sample.bytes;
    out.packets += sample.packets;
    out.energy += sample.energy;
    out.streams += 1;
  }
  return out;
}

/**
 * Inbound audio that ARRIVED during the window ("is sound arriving right
 * now?"). Computed per stream: a stream that appears mid-window counts in
 * full, one that disappears counts nothing — summing raw totals went
 * negative whenever a publication was replaced (e.g. PTT's first publish).
 */
async function audioDelta(page: Page, windowMs = 3000) {
  const a = await inboundAudioStreams(page);
  await page.waitForTimeout(windowMs);
  const b = await inboundAudioStreams(page);
  const out = { bytes: 0, packets: 0, energy: 0, streams: Object.keys(b).length };
  for (const [id, after] of Object.entries(b)) {
    const before = a[id] ?? { bytes: 0, packets: 0, energy: 0 };
    out.bytes += Math.max(0, after.bytes - before.bytes);
    out.packets += Math.max(0, after.packets - before.packets);
    out.energy += Math.max(0, after.energy - before.energy);
  }
  return out;
}

async function remoteAudioElements(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAudioElement>('audio[data-livekit-remote-audio]')).map((el) => ({
      paused: el.paused,
      muted: el.muted,
      volume: el.volume,
      live: (el.srcObject as MediaStream | null)?.getAudioTracks().some((t) => t.readyState === 'live') ?? false,
    }))
  );
}

async function newUserContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: baseUrl, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(hookPeerConnections);
  ctx.on('response', async (r) => {
    if (r.status() >= 400) {
      const req = r.request();
      console.info('[http]', req.method(), r.status(), r.url().replace(baseUrl, ''), 'origin=', (await req.allHeaders())['origin'] ?? '(none)');
    }
  });
  return ctx;
}

async function joinVoice(page: Page, serverId: string) {
  await page.goto(`/lobby?server=${serverId}`);
  const voiceChannel = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
  await expect(voiceChannel).toBeVisible();
  await voiceChannel.click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

/** Product defects observed; reported together at the end so every scenario runs. */
const defects: string[] = [];
function check(ok: boolean, defect: string) {
  if (!ok) defects.push(defect);
}

test.describe('voice through the real lobby UI', () => {
  let ownerCtx: BrowserContext;
  let guestCtx: BrowserContext;
  let owner: Page;
  let guest: Page;
  let serverId = '';
  let voiceChannelId = '';
  let guestUid = '';

  let ownBrowser: Browser;

  test.beforeAll(async ({ playwright }) => {
    // Own browser WITHOUT the config's --disable-web-security: that flag makes
    // Chromium drop the Origin header, which the app's CSRF guard (rightly) rejects.
    ownBrowser = await playwright.chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const browser = ownBrowser;
    ownerCtx = await newUserContext(browser);
    guestCtx = await newUserContext(browser);

    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Voice UI E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await ownerCtx.request.post('/api/auth/login', {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      expect(login.status(), 'owner login on warm stack').toBe(200);
    }

    const { servers } = (await (await ownerCtx.request.get('/api/servers')).json()) as {
      servers: Array<{ id: string }>;
    };
    serverId = servers[0]!.id;
    const { channels } = (await (await ownerCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;

    expect((await guestCtx.request.post('/api/auth/guest', { headers: ORIGIN, data: {} })).status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    expect((await guestCtx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const me = (await (await guestCtx.request.get('/api/auth/guest')).json()) as { guest: { uid: string } };
    guestUid = me.guest.uid;
    expect(guestUid).toBeTruthy();

    owner = await ownerCtx.newPage();
    guest = await guestCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
    await guestCtx?.close();
    await ownBrowser?.close();
  });

  test('both users join from the UI and hear each other', async () => {
    test.setTimeout(120_000);
    await joinVoice(owner, serverId);
    await joinVoice(guest, serverId);

    // Wait for the subscription to settle, then require live audio both ways.
    await expect.poll(async () => (await inboundAudio(owner)).packets, { timeout: 30_000 }).toBeGreaterThan(20);
    await expect.poll(async () => (await inboundAudio(guest)).packets, { timeout: 30_000 }).toBeGreaterThan(20);

    const o = await audioDelta(owner);
    const g = await audioDelta(guest);
    console.info('[audio] owner receives', o, '| guest receives', g);
    expect(o.bytes).toBeGreaterThan(0);
    expect(o.energy).toBeGreaterThan(0);
    expect(g.bytes).toBeGreaterThan(0);
    expect(g.energy).toBeGreaterThan(0);

    for (const page of [owner, guest]) {
      const els = await remoteAudioElements(page);
      console.info('[audio] elements', els);
      expect(els.length).toBeGreaterThanOrEqual(1);
      expect(els.every((e) => !e.paused && !e.muted && e.volume > 0 && e.live)).toBe(true);
    }
  });

  test('local mute silences the sender for the listener; unmute restores it', async () => {
    await owner.getByTitle('Mute', { exact: true }).click();
    await expect(owner.getByTitle('Unmute', { exact: true })).toBeVisible();
    await guest.waitForTimeout(1500);
    const muted = await audioDelta(guest);
    console.info('[audio] guest receives while owner muted', muted);
    expect(muted.energy).toBe(0);

    await owner.getByTitle('Unmute', { exact: true }).click();
    await expect.poll(async () => (await audioDelta(guest, 2000)).energy, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('deafen stops incoming audio; undeafen restores it', async () => {
    await guest.getByTitle('Deafen', { exact: true }).click();
    await expect(guest.getByTitle('Undeafen', { exact: true })).toBeVisible();
    await guest.waitForTimeout(1500);
    const deaf = await audioDelta(guest);
    console.info('[audio] guest receives while deafened', deaf);
    expect(deaf.energy).toBe(0);

    await guest.getByTitle('Undeafen', { exact: true }).click();
    await expect.poll(async () => (await audioDelta(guest, 2000)).energy, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('moderator server-mute holds even if the target clicks Unmute', async () => {
    test.setTimeout(120_000);
    const res = await ownerCtx.request.post(
      `/api/servers/${serverId}/channels/${voiceChannelId}/members/${guestUid}/voice/mute`,
      { headers: ORIGIN, data: { muted: true } }
    );
    console.info('[audio] server-mute status', res.status(), await res.text());
    expect(res.status()).toBe(200);

    await expect.poll(async () => (await audioDelta(owner, 2000)).energy, { timeout: 15_000 }).toBe(0);
    // The target's UI must reflect the moderator mute.
    const moderatorMuted = guest.getByTitle('Muted by a moderator', { exact: true });
    await expect.poll(() => moderatorMuted.count(), { timeout: 10_000 }).toBe(1).catch(() => {});
    check(
      (await moderatorMuted.count()) === 1,
      'server-mute: target UI does not show the moderator mute'
    );

    // Bypass attempts: toggle the mic, then rejoin — neither may bring the voice back.
    for (const title of ['Muted by a moderator', 'Mute', 'Unmute']) {
      const button = guest.getByTitle(title, { exact: true });
      if (await button.isVisible()) await button.click();
    }
    await guest.waitForTimeout(3000);
    const afterToggle = await audioDelta(owner);
    console.info('[audio] owner receives after server-muted guest toggled the mic', afterToggle);
    check(afterToggle.energy === 0, 'server-mute: the muted user can unmute themselves and be heard again');

    await guest.reload();
    await joinVoice(guest, serverId);
    await guest.waitForTimeout(3000);
    const afterRejoin = await audioDelta(owner);
    console.info('[audio] owner receives after server-muted guest rejoined', afterRejoin);
    check(afterRejoin.energy === 0, 'server-mute: rejoining the channel removes the moderator mute');

    // Lifting the mute must NOT switch the mic on remotely…
    await ownerCtx.request.post(
      `/api/servers/${serverId}/channels/${voiceChannelId}/members/${guestUid}/voice/mute`,
      { headers: ORIGIN, data: { muted: false } }
    );
    await guest.waitForTimeout(2000);
    const afterLift = await audioDelta(owner);
    check(afterLift.energy === 0, 'server-unmute: the moderator switched the user microphone on remotely');
    // …but the user can talk again once they unmute themselves.
    await expect(guest.getByTitle('Unmute', { exact: true })).toBeVisible({ timeout: 10_000 });
    await guest.getByTitle('Unmute', { exact: true }).click();
    await expect.poll(async () => (await audioDelta(owner, 2000)).energy, { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test('reload + rejoin restores audio both ways', async () => {
    test.setTimeout(90_000);
    await guest.reload();
    await joinVoice(guest, serverId);
    await expect.poll(async () => (await audioDelta(guest, 2000)).energy, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await audioDelta(owner, 2000)).energy, { timeout: 30_000 }).toBeGreaterThan(0);
    // Exactly one inbound audio stream for the owner (no ghost participant).
    const o = await inboundAudio(owner);
    let els = await remoteAudioElements(owner);
    for (let i = 0; i < 15 && els.length > 1; i++) {
      await owner.waitForTimeout(2000);
      els = await remoteAudioElements(owner);
    }
    console.info('[audio] owner inbound after guest rejoin', o, 'audio elements (after up to 30s)', els);
    check(els.length === 1, 'rejoin: listener keeps a stale remote <audio> element for the old session (' + els.length + ' elements after 30s)');
  });

  test('chat message reaches the other user in realtime (ws-gateway)', async () => {
    const text = `realtime-check-${Date.now()}`;
    const input = owner.getByPlaceholder(/^Message #/);
    await expect(input).toBeVisible();
    await input.fill(text);
    await input.press('Enter');
    await expect(owner.getByText(text)).toBeVisible({ timeout: 10_000 });
    // No reload on the guest side: delivery must come over the realtime channel.
    await expect(guest.getByText(text)).toBeVisible({ timeout: 10_000 });
  });

  /** A fresh invited guest context (optionally with a broken microphone). */
  async function extraGuest(opts: { denyMic?: boolean } = {}) {
    const ctx = await newUserContext(ownBrowser);
    if (opts.denyMic) {
      await ctx.addInitScript(() => {
        const md = navigator.mediaDevices;
        const native = md.getUserMedia.bind(md);
        md.getUserMedia = (c?: MediaStreamConstraints) =>
          c?.audio ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : native(c);
      });
    }
    expect((await ctx.request.post('/api/auth/guest', { headers: ORIGIN, data: {} })).status()).toBe(200);
    const { invite } = (await (
      await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} })
    ).json()) as { invite: { code: string } };
    expect((await ctx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    return { ctx, page: await ctx.newPage() };
  }

  test('a deafened user stays deaf when someone new joins', async () => {
    test.setTimeout(90_000);
    await guest.getByTitle('Deafen', { exact: true }).click();
    await expect(guest.getByTitle('Undeafen', { exact: true })).toBeVisible();
    await expect.poll(async () => (await audioDelta(guest, 2000)).energy, { timeout: 15_000 }).toBe(0);

    const third = await extraGuest();
    await joinVoice(third.page, serverId);
    await third.page.waitForTimeout(5000);
    const whileDeaf = await audioDelta(guest);
    console.info('[audio] deafened guest receives after a third user joined', whileDeaf);
    check(whileDeaf.energy === 0, 'deafen: a participant who joins AFTER deafening is audible to the deafened user');

    await third.ctx.close();
    await guest.getByTitle('Undeafen', { exact: true }).click();
  });

  test('microphone permission denied still allows listen-only voice', async () => {
    test.setTimeout(90_000);
    const listener = await extraGuest({ denyMic: true });
    await listener.page.goto(`/lobby?server=${serverId}`);
    await listener.page
      .locator('button')
      .filter({ has: listener.page.locator('span', { hasText: 'volume_up' }) })
      .first()
      .click();
    await listener.page.waitForTimeout(8000);
    const connected = await listener.page.getByText('Voice Connected').count();
    const alerts = await listener.page.getByRole('alert').allInnerTexts();
    const heard = await audioDelta(listener.page);
    console.info('[audio] mic-denied user: connected=', connected, 'alerts=', alerts, 'receives', heard);
    check(connected === 1, 'mic denied: the whole voice join fails instead of joining listen-only (' + alerts.join(' / ') + ')');
    check(heard.energy > 0, 'mic denied: the user cannot even listen to the room');
    await listener.ctx.close();
  });

  test('push-to-talk transmits for the whole time the key is held', async () => {
    test.setTimeout(120_000);
    const patch = (requirePushToTalk: boolean) =>
      ownerCtx.request.patch(`/api/servers/${serverId}/voice-settings`, {
        headers: ORIGIN,
        data: { requirePushToTalk },
      });
    expect((await patch(true)).status()).toBe(200);
    try {
      // Rejoin so the server policy applies.
      await guest.reload();
      await joinVoice(guest, serverId);
      await expect(guest.getByTitle('Unmute', { exact: true })).toBeVisible();
      await guest.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect.poll(async () => (await audioDelta(owner, 2000)).energy, { timeout: 15_000 }).toBe(0);

      await guest.keyboard.down('Space');
      await guest.waitForTimeout(1500); // publish / unmute latency
      const during = await audioDelta(owner, 4000);
      const micTitleWhileHeld = (await guest.getByTitle('Mute', { exact: true }).count()) ? 'Mute (mic open)' : 'Unmute (mic closed)';
      await guest.keyboard.up('Space');
      await guest.waitForTimeout(1500);
      const after = await audioDelta(owner, 3000);
      console.info('[audio] PTT held → owner receives', during, 'footer:', micTitleWhileHeld, '| released →', after);
      check(during.energy > 0, 'push-to-talk: holding the key does not keep the mic open (listener hears nothing)');
      check(after.energy === 0, 'push-to-talk: mic stays open after the key is released');
    } finally {
      await patch(false);
    }
  });

  test('no voice defects observed', () => {
    console.info('[defects]\n - ' + (defects.length ? defects.join('\n - ') : 'none'));
    expect(defects).toEqual([]);
  });
});
