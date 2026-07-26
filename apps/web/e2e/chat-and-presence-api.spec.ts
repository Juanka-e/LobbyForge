import { test, expect } from '@playwright/test';

/**
 * Tier 2/3 — Chat + presence API boundary cases.
 *
 * These tests hit the chat/typing/presence REST endpoints directly and
 * assert validation + membership enforcement. They do NOT assert real-time
 * delivery (which needs the ws-gateway); they only check the API contract.
 *
 * Prerequisites: docker compose dev stack (Postgres + Redis) up, and a
 * bootstrapped server the test guest is NOT a member of. The route enforces
 * membership, so non-member UUIDs yield 403/404 — that is the assertion.
 */

const NON_MEMBER_SERVER = '00000000-0000-0000-0000-000000000090';
const NON_MEMBER_CHANNEL = '00000000-0000-0000-0000-000000000091';

test.describe('Chat + presence API boundaries', () => {
  test('rejects a message POST to a channel the caller is not a member of', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'Chat Probe' } });
    expect(created.ok()).toBeTruthy();
    const res = await request.post(
      `/api/servers/${NON_MEMBER_SERVER}/channels/${NON_MEMBER_CHANNEL}/messages`,
      { data: { content: 'hello' } }
    );
    expect([403, 404]).toContain(res.status());
  });

  test('rejects a typing POST to a channel the caller is not a member of', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'Typing Probe' } });
    expect(created.ok()).toBeTruthy();
    const res = await request.post(
      `/api/servers/${NON_MEMBER_SERVER}/channels/${NON_MEMBER_CHANNEL}/typing`
    );
    expect([403, 404]).toContain(res.status());
  });

  test('rejects a channel-presence GET for a non-member channel', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'Presence Read' } });
    expect(created.ok()).toBeTruthy();
    const res = await request.get(
      `/api/servers/${NON_MEMBER_SERVER}/channels/${NON_MEMBER_CHANNEL}/presence`
    );
    expect([403, 404]).toContain(res.status());
  });

  test('rejects invite creation without CREATE_INVITE permission on a foreign server', async ({ request }) => {
    const created = await request.post('/api/auth/guest', { data: { displayNameSeed: 'Invite Probe' } });
    expect(created.ok()).toBeTruthy();
    const res = await request.post(`/api/servers/${NON_MEMBER_SERVER}/invites`, {
      data: { maxUses: 5 },
    });
    expect([403, 404]).toContain(res.status());
  });

  test('public invite metadata lookup returns 404 for an unknown code', async ({ request }) => {
    const res = await request.get('/api/invites/NOTACODE1234');
    // Either 400 (invalid format) or 404 (not found) is acceptable here.
    expect([400, 404]).toContain(res.status());
  });

  test('redeeming an unknown invite returns 401/403 without a session', async ({ request }) => {
    const res = await request.post('/api/invites/UNKNOWNCODE12/redeem');
    // No cookie → 401 (no session) is the expected gate.
    expect([401, 403]).toContain(res.status());
  });
});
