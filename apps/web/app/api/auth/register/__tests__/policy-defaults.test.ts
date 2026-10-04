import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: with NO saved access policy the settings page showed
 * "Invite only" while registration allowed invite-less sign-up (it only
 * applies a saved row). Saving those displayed values then closed
 * registration. The displayed default is now the enforced one.
 *
 * This drives the real routes — GET then PATCH /api/servers/{id}/access-policy
 * and POST /api/auth/register — over the REAL query functions
 * (getEffectiveServerAccessPolicy, upsertServerAccessPolicy,
 * getServerAccessPolicy, serverPolicyRegistrationRefusal) on an in-memory
 * policy store.
 */

const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

let stored: Record<string, unknown> | null = null;

/** Just enough of the Drizzle client for the access-policy queries. */
const fakeDb = {
  select: () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => (stored ? [stored] : []),
    };
    return chain;
  },
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      returning: async () => {
        stored = { id: 'pol-1', updatedAt: new Date(), ...values };
        return [stored];
      },
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          stored = { ...stored, ...values };
          return [stored];
        },
      }),
    }),
  }),
};

const createLocalAccount = vi.fn();

vi.mock('@lobbyforge/db', async () => {
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    getEffectiveServerAccessPolicy: actual.getEffectiveServerAccessPolicy,
    upsertServerAccessPolicy: actual.upsertServerAccessPolicy,
    getServerAccessPolicy: actual.getServerAccessPolicy,
    serverPolicyRegistrationRefusal: actual.serverPolicyRegistrationRefusal,
    logAction: async () => undefined,
    createLocalAccount,
    getEffectiveInstanceAccessSettings: async () => ({ registrationMode: 'open' }),
    getInstanceBootstrapStatus: async () => ({ bootstrapComplete: true, firstServerId: SERVER }),
    getInviteMetadata: async () => null,
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => fakeDb }));
vi.mock('@/lib/api-auth', () => ({
  CorePermission: { MANAGE_SERVER: 'manage_server' },
  getSessionSecret: () => 'x'.repeat(32),
  requireMaterializedSession: () => ({ ok: true, session: { uid: OWNER, gid: 'g_1', name: 'Owner', exp: 1 } }),
  requireServerMember: async () => ({ ok: true }),
  requireServerPermission: async () => ({ ok: true }),
}));
vi.mock('@/lib/password', () => ({ hashPassword: async () => 'scrypt$hash' }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => false }));
vi.mock('@/lib/official-account', () => ({ createOfficialAccount: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ recordSession: async () => undefined }));
vi.mock('@/lib/bots/welcome', () => ({ notifyMemberJoined: async () => undefined }));
vi.mock('@/lib/guest-session', () => ({
  createGuestIdentity: () => ({ gid: `g_${'a'.repeat(32)}`, uid: null, name: 'Guest' }),
  buildGuestSessionCookie: () => ({ setCookieHeader: 'lf_guest=signed; HttpOnly; SameSite=Lax' }),
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
// Bot protection is covered by lib/captcha/__tests__ — a pass-through here.
vi.mock('@/lib/captcha/guard', () => ({ guardCaptchaSurface: async () => null }));

const ctx = () => ({ params: Promise.resolve({ id: SERVER }) });

async function getPolicy(): Promise<Record<string, unknown>> {
  const { GET } = await import('@/app/api/servers/[id]/access-policy/route');
  const res = await GET(new Request(`https://community.example/api/servers/${SERVER}/access-policy`), ctx());
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessPolicy: Record<string, unknown> }).accessPolicy;
}

async function savePolicy(values: Record<string, unknown>): Promise<number> {
  const { PATCH } = await import('@/app/api/servers/[id]/access-policy/route');
  const res = await PATCH(
    new Request(`https://community.example/api/servers/${SERVER}/access-policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
    }),
    ctx()
  );
  return res.status;
}

async function registerWithoutInvite(): Promise<number> {
  const { POST } = await import('../route.js');
  const res = await POST(
    new Request('https://community.example/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', displayName: 'Newcomer', password: 'long password 42!' }),
    }),
    {}
  );
  return res.status;
}

function editable(policy: Record<string, unknown>) {
  return {
    joinPolicy: policy.joinPolicy,
    externalIdentity: policy.externalIdentity,
    localAccount: policy.localAccount,
    accountLinking: policy.accountLinking,
    requireApprovalForFirstJoin: policy.requireApprovalForFirstJoin,
  };
}

beforeEach(() => {
  vi.resetModules();
  stored = null;
  createLocalAccount.mockReset();
  createLocalAccount.mockResolvedValue({
    ok: true,
    user: { id: 'user-id', email: 'new@example.com', displayName: 'Newcomer' },
    serverId: SERVER,
  });
});

describe('access-policy defaults and registration', () => {
  it('GET defaults → PATCH the same values does not change registration', async () => {
    // No saved policy: invite-less registration works on an open instance.
    expect(await registerWithoutInvite()).toBe(201);

    const defaults = await getPolicy();
    expect(defaults).toMatchObject({ id: null, joinPolicy: 'public_self_register' });

    expect(await savePolicy(editable(defaults))).toBe(200);
    expect(stored).toMatchObject({ joinPolicy: 'public_self_register' });

    // Same values saved: registration behaves exactly as before.
    expect(await registerWithoutInvite()).toBe(201);
    expect(editable(await getPolicy())).toEqual(editable(defaults));
  });

  it('the test can tell: saving "Invite only" does close invite-less registration', async () => {
    const defaults = await getPolicy();
    expect(await savePolicy({ ...editable(defaults), joinPolicy: 'invite_only' })).toBe(200);
    expect(await registerWithoutInvite()).toBe(403);
    expect(createLocalAccount).not.toHaveBeenCalled();
  });
});
