/**
 * TEST-001: production TLS edge e2e.
 *
 * Runs against the PRODUCTION compose stack (nginx + web + ws-gateway +
 * livekit + postgres + redis) with a real — self-signed in CI —
 * certificate on nginx. The dev-stack e2e (compose-stack.spec.ts)
 * exercises the app over plain HTTP on :3000; this spec proves the edge
 * that production users actually hit:
 *   - HTTPS termination + reverse proxy to the web container
 *   - the HTTP → HTTPS redirect at the edge
 *   - the WSS /ws upgrade through nginx into the ws-gateway (which
 *     completes the handshake then closes 4401 unauthenticated — a
 *     cookie-less client must be rejected AFTER the socket opens)
 *
 * Gated by LF_E2E_TLS: the playwright config maps the CI domain to
 * loopback and accepts the self-signed cert only in that mode.
 */
import { expect, test } from '@playwright/test';

test.skip(() => !process.env.LF_E2E_TLS, 'TEST-001: prod TLS stack not targeted');

const BASE_URL = process.env.LF_E2E_BASE_URL ?? '';

test.describe('production TLS edge (TEST-001)', () => {
  test('health endpoint answers over HTTPS through nginx', async ({ page }) => {
    const res = await page.request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Whatever shape the health payload has, it must be JSON from the
    // app — not an nginx error page.
    expect(typeof body).toBe('object');
  });

  test('plain HTTP is redirected to HTTPS at the edge', async ({ page }) => {
    const httpUrl = BASE_URL.replace(/^https:/, 'http:');
    const res = await page.request.get(httpUrl, { maxRedirects: 0 });
    expect([301, 302, 308]).toContain(res.status());
    const location = res.headers()['location'] ?? '';
    expect(location).toMatch(/^https:\/\//);
  });

  test('landing page renders over HTTPS', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.ok()).toBe(true);
    // TLS context is real: the page origin must be https.
    expect(new URL(page.url()).protocol).toBe('https:');
  });

  test('LF-SEC-012: upload paths accept big bodies at the edge, others 413', async ({ page }) => {
    // A ~7.5 MiB JSON body — banner-scale (the app accepts data URLs up
    // to 8 MiB there; the avatar route caps at 6 MiB). The edge allows
    // 12m on upload paths, so the APP must answer (401 — no session),
    // proving nginx didn't cut the body off.
    const bigBody = JSON.stringify({ dataUrl: 'x'.repeat(Math.floor(7.5 * 1024 * 1024)) });
    const bannerRes = await page.request.post('/api/users/me/banner', {
      data: bigBody,
      headers: { 'content-type': 'application/json' },
    });
    expect(bannerRes.status()).toBe(401); // reached the app, auth said no

    // The SAME body against a normal API path (2m global cap) must be
    // rejected BY THE EDGE with 413 — per-route limits actually apply.
    const guestRes = await page.request.post('/api/auth/guest', {
      data: bigBody,
      headers: { 'content-type': 'application/json' },
    });
    expect(guestRes.status()).toBe(413);
  });

  test('WSS /ws upgrade reaches the gateway (4401 unauthenticated)', async ({ page }) => {
    await page.goto('/');
    const outcome = await page.evaluate(
      () =>
        new Promise<{ opened: boolean; closeCode: number | null }>((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/ws`);
          let opened = false;
          ws.onopen = () => {
            opened = true;
          };
          ws.onclose = (ev) => resolve({ opened, closeCode: ev.code });
          ws.onerror = () => {
            /* onclose always follows onerror */
          };
          setTimeout(() => resolve({ opened, closeCode: null }), 10_000);
        })
    );
    // The gateway completes the WebSocket upgrade THROUGH the TLS edge
    // and then closes with its auth-rejection code — proving both the
    // wss:// proxying and the gateway's auth gate.
    expect(outcome.opened).toBe(true);
    expect(outcome.closeCode).toBe(4401);
  });
});
