import { test, expect } from '@playwright/test';

/**
 * Tier 2 — Guest auth boundary / validation cases.
 *
 * These tests exercise the `/api/auth/guest` route's input validation
 * without needing a fully-bootstrapped server. They rely on the webServer
 * (auto-started by Playwright) + Postgres for guest materialization.
 */

test.describe('Guest auth boundaries', () => {
  test('rejects an overlong displayNameSeed (>48 chars)', async ({ request }) => {
    const res = await request.post('/api/auth/guest', {
      data: { displayNameSeed: 'x'.repeat(200) },
    });
    expect(res.status()).toBe(400);
  });

  test('rejects an unknown (extra) body field due to .strict()', async ({ request }) => {
    const res = await request.post('/api/auth/guest', {
      data: { displayNameSeed: 'Alice', rogueField: true },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /api/auth/guest returns 401 when no cookie is present', async ({ request }) => {
    const res = await request.get('/api/auth/guest');
    expect(res.status()).toBe(401);
  });

  test('GET /api/auth/guest returns the session after a guest is created', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'E2E Alice' } });
    expect(created.ok()).toBeTruthy();
    // The Playwright `request` context carries the Set-Cookie automatically.
    const me = await request.get('/api/auth/guest');
    expect(me.ok()).toBeTruthy();
    const body = await me.json();
    expect(body.guest).toBeDefined();
    expect(typeof body.guest.gid).toBe('string');
  });

  test('a materialized guest cannot write presence to a non-member server', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'Presence Probe' } });
    expect(created.ok()).toBeTruthy();
    const res = await request.post('/api/presence', {
      data: {
        serverId: '00000000-0000-0000-0000-000000000090',
        channelId: '00000000-0000-0000-0000-000000000091',
        status: 'online',
      },
    });
    expect([403, 404]).toContain(res.status());
  });
});
