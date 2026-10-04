/**
 * Bot protection on POST /api/auth/register through the REAL guard
 * (docs/CAPTCHA.md §2): an invite can only ADD protection. On an open
 * instance — where `@everyone` may create unlimited invites — an invite
 * sign-up is challenged whenever `register` is on, even with
 * `invite_register` off; only an invite-only instance lets
 * `invite_register` alone decide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  captcha: {} as Record<string, unknown>,
  registrationMode: 'open' as string,
  createLocalAccount: vi.fn(),
}));

vi.mock('@lobbyforge/db', async () => {
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    getInstanceCaptchaSettings: async () => ({ ...h.captcha }),
    getEffectiveInstanceAccessSettings: async () => ({ registrationMode: h.registrationMode }),
    getInstanceBootstrapStatus: async () => ({ bootstrapComplete: true, firstServerId: 'server-id' }),
    getInviteMetadata: async () => ({ serverId: 'server-id', isExpired: false, isExhausted: false }),
    getServerAccessPolicy: async () => null,
    serverPolicyRegistrationRefusal: actual.serverPolicyRegistrationRefusal,
    createLocalAccount: h.createLocalAccount,
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/password', () => ({ hashPassword: async () => 'scrypt$hash' }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => false }));
vi.mock('@/lib/official-account', () => ({ createOfficialAccount: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ recordSession: async () => undefined }));
vi.mock('@/lib/bots/welcome', () => ({ notifyMemberJoined: async () => undefined }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});

import { invalidateCaptchaSettingsCache } from '@/lib/captcha/settings';

const body = { email: 'bot@example.com', displayName: 'Bot', password: 'long password 42!', inviteCode: 'ABCD2345EFGH' };

function captcha(register: string, inviteRegister: string) {
  h.captcha = {
    instanceId: 'self-host',
    provider: 'altcha',
    surfaces: { register, invite_register: inviteRegister, guest: 'on', login: 'adaptive' },
    siteKey: null,
    secretEncrypted: null,
    options: {},
    attackMode: false,
    updatedAt: null,
  };
  invalidateCaptchaSettingsCache();
}

async function post(payload: Record<string, unknown>) {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://community.example/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    {}
  );
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'z'.repeat(40));
  vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', '');
  h.registrationMode = 'open';
  h.createLocalAccount.mockReset().mockResolvedValue({
    ok: true,
    user: { id: 'user-id', email: body.email, displayName: body.displayName },
    serverId: 'server-id',
  });
});

describe('register with an invite — bot protection through the real guard', { timeout: 20_000 }, () => {
  it('an open instance with register on: an invite does NOT skip the challenge (invite_register off)', async () => {
    captcha('on', 'off');
    for (let i = 0; i < 3; i += 1) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'captcha_required' });
    }
    expect(h.createLocalAccount).not.toHaveBeenCalled();
  });

  it('an open instance with register off and invite_register on: the invite sign-up is challenged too', async () => {
    captcha('off', 'on');
    expect(await (await post(body)).json()).toEqual({ error: 'captcha_required' });
  });

  it('an open instance with both off: no challenge', async () => {
    captcha('off', 'off');
    expect((await post(body)).status).toBe(201);
  });

  it('an invite-only instance: invite_register alone decides (it trusts whoever can create invites)', async () => {
    h.registrationMode = 'invite_only';
    captcha('on', 'off');
    expect((await post(body)).status).toBe(201);
    captcha('off', 'on');
    expect(await (await post(body)).json()).toEqual({ error: 'captcha_required' });
  });
});
