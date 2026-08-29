/**
 * V5-008: REAL two-client voice E2E. Two DISTINCT users (owner + an
 * invited guest) each get a LiveKit token, then two separate browser
 * contexts load the livekit-client UMD bundle and:
 *
 *   A) connect to the room over the real signaling path
 *   B) publish a (fake-device) microphone track
 *   C) the OTHER client receives the audio track (TrackSubscribed)
 *   D) data channel round-trip proves bidirectional connectivity
 *
 * Chromium runs with --use-fake-device-for-media-stream (playwright
 * config), so getUserMedia yields a real audio track without hardware.
 * Runs against the compose stack (LF_E2E_BASE_URL) — the same LiveKit
 * the app uses, proving the media path end to end.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const LIVEKIT_WS = process.env.LF_E2E_LIVEKIT_URL ?? 'ws://localhost:7880';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

const umdPath = resolve(
  here,
  '..',
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.umd.js'
);

/** Drive livekit-client inside a browser page; resolves with the result. */
async function runInPage(
  page: import('@playwright/test').Page,
  script: string
): Promise<unknown> {
  return page.evaluate(`new Promise((resolveRun) => {
    window.__resolveRun = resolveRun;
    try {
      ${script}
    } catch (err) {
      resolveRun({ error: String(err) });
    }
  })`);
}

test.describe('two-client voice over the real LiveKit', () => {
  test('two users connect, publish audio, and subscribe to each other', async ({
    browser,
    playwright,
  }) => {
    test.setTimeout(90_000);

    // ── 1. Two identities: the bootstrap owner + a guest the owner invites.
    const ownerCtx = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } });
    // Owner session: fresh stack → setup; warm stack → login (both work).
    const OWNER_EMAIL = 'owner@e2e.local';
    const OWNER_PASSWORD = 'compose-e2e-owner-pw';
    const setupRes = await ownerCtx.post('/api/setup/complete', {
      headers: { Origin: baseUrl },
      data: {
        setupToken: process.env.LF_E2E_SETUP_TOKEN ?? '',
        instanceName: 'Voice E2E',
        ownerDisplayName: 'Voice Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setupRes.status() !== 200) {
      const login = await ownerCtx.post('/api/auth/login', {
        headers: { Origin: baseUrl },
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      expect([200, 401]).toContain(login.status());
      test.skip(
        login.status() !== 200,
        'Warm stack provisioned by someone else — rerun on a fresh volume for voice E2E.'
      );
    }

    const serversRes = await ownerCtx.get('/api/servers');
    expect(serversRes.status()).toBe(200);
    const { servers } = (await serversRes.json()) as { servers: Array<{ id: string }> };
    const serverId = servers[0]!.id;

    const channelsRes = await ownerCtx.get(`/api/servers/${serverId}/channels`);
    const { channels } = (await channelsRes.json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    const voiceChannel = channels.find((c) => c.type === 'voice')!;

    // Guest identity + invite redemption = real second member.
    const guestCtx = await playwright.request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: { Origin: baseUrl },
    });
    const guestAuth = await guestCtx.post('/api/auth/guest', { data: {} });
    expect(guestAuth.status()).toBe(200);

    const inviteRes = await ownerCtx.post(`/api/servers/${serverId}/invites`, {
      headers: { Origin: baseUrl },
      data: {},
    });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    // The redeem route allows NO body (maxBodyBytes: 0) — omit data.
    const redeemRes = await guestCtx.post(`/api/invites/${invite.code}/redeem`, {
      headers: { Origin: baseUrl },
    });
    expect(redeemRes.status()).toBe(201);

    // ── 2. Voice tokens for BOTH users.
    const tokenFor = async (ctx: typeof ownerCtx) => {
      const res = await ctx.post('/api/livekit/token', {
        headers: { Origin: baseUrl },
        data: { serverId, channelId: voiceChannel.id },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { token: string };
      return body.token;
    };
    const ownerJwt = await tokenFor(ownerCtx);
    const guestJwt = await tokenFor(guestCtx);
    expect(ownerJwt).toBeTruthy();
    expect(guestJwt).toBeTruthy();

    // ── 3. Two browser contexts, each a real livekit-client.
    const umd = readFileSync(umdPath, 'utf8');
    const connectScript = (jwt: string, label: string) => `
      const room = new LivekitClient.Room({
        adaptiveStream: false,
        // CI/Windows loopback ICE can be slow to gather pairs.
        peerConnectionTimeout: 45000,
      });
      window.__room = room;
      const events = [];
      room.on('trackSubscribed', (track) => {
        if (track.kind === 'audio') events.push('subscribed:audio');
      });
      room.on('dataReceived', (payload) => {
        const text = new TextDecoder().decode(payload);
        events.push('data:' + text);
      });
      room.on('participantConnected', () => events.push('peer'));
      room.connect('${LIVEKIT_WS}', '${jwt}', { autoSubscribe: true }).then(async () => {
        // Publish the fake-device microphone.
        await room.localParticipant.setMicrophoneEnabled(true);
        events.push('connected+mic');
        window.__voiceEvents = events;
        window.__resolveRun({ label: '${label}', connected: true, sid: room.localParticipant.sid });
      }).catch((err) => window.__resolveRun({ label: '${label}', error: String(err) }));
    `;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    // Serve a synthetic harness page at the app's ORIGIN via route
    // interception: same-origin (no opaque-origin CORS problems) while
    // OUR response headers carry no CSP — the app's strict CSP would
    // block both the inline script and connect-src to the LiveKit port.
    for (const page of [pageA, pageB]) {
      await page.route('**/lf-voice-harness.html', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body><script src="/lf-test-livekit-client.js"></script></body></html>',
        })
      );
      await page.route('**/lf-test-livekit-client.js', (route) =>
        route.fulfill({ body: umd, contentType: 'application/javascript' })
      );
      await page.goto(new URL('/lf-voice-harness.html', baseUrl).toString(), {
        waitUntil: 'load',
      });
    }

    const resultA = await runInPage(pageA, connectScript(ownerJwt, 'owner'));
    const resultB = await runInPage(pageB, connectScript(guestJwt, 'guest'));
    expect(resultA).toMatchObject({ connected: true });
    expect(resultB).toMatchObject({ connected: true });

    // ── 4. Owner sends a data message; guest must receive it (and vice
    // versa), proving bidirectional connectivity beyond signalling.
    await pageA.evaluate(() =>
      window.__room.localParticipant.publishData(new TextEncoder().encode('ping-from-owner'))
    );
    await pageB.evaluate(() =>
      window.__room.localParticipant.publishData(new TextEncoder().encode('pong-from-guest'))
    );

    // ── 5. Both sides must eventually see the peer AND an audio track.
    await expect
      .poll(async () => pageA.evaluate(() => window.__voiceEvents.length), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const eventsA = await pageA.evaluate(() => window.__voiceEvents);
    const eventsB = await pageB.evaluate(() => window.__voiceEvents);
    // Owner sees guest's mic; guest sees owner's mic (fake device tone).
    expect(eventsA).toContain('subscribed:audio');
    expect(eventsB).toContain('subscribed:audio');
    // Data round-trip.
    expect(eventsA).toContain('data:pong-from-guest');
    expect(eventsB).toContain('data:ping-from-owner');

    await ctxA.close();
    await ctxB.close();
    await ownerCtx.dispose();
    await guestCtx.dispose();
  });
});
