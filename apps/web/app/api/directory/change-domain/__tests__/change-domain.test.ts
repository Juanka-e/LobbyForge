/**
 * beta-review (S10): POST /api/directory/change-domain must bind the new
 * domain to the instance's STORED key (not whatever key the new
 * domain's document claims) and send the entry back through review.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signEd25519, type KeyObject } from 'node:crypto';

const requireMaterializedSession = vi.fn();
const getRegistryInstanceByInstanceId = vi.fn();
const changeRegistryInstanceDomain = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => ({
  getRegistryInstanceByInstanceId,
  changeRegistryInstanceDomain,
}));
vi.mock('@lobbyforge/registry', () => ({
  normalizeRegistryInstanceUrl: (url: string) => {
    if (!url.startsWith('https://')) throw new Error('must use HTTPS');
    return url.replace(/\/$/, '');
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const { ssrfSafeGet, redisSet } = vi.hoisted(() => ({
  ssrfSafeGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock('@/lib/ssrf-safe-fetch', () => ({ ssrfSafeGet }));
vi.mock('@/lib/redis', () => ({ redis: { set: (...a: unknown[]) => redisSet(...a) } }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

const UID = '00000000-0000-0000-0000-000000000099';
const INSTANCE_ID = 'inst-1';
const OLD_DOMAIN = 'https://old.example.com';
const NEW_DOMAIN = 'https://new.example.com';

function keyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicDerB64: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicDerB64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const stored = keyPair();
const attacker = keyPair();

function signB64(privateKey: KeyObject, payload: string): string {
  return signEd25519(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

/** A well-known document for NEW_DOMAIN, self-consistent for `docKey`. */
function wellKnownFor(docKey: { privateKey: KeyObject }, publicKeyField: string): string {
  const canonical = JSON.stringify({
    verify: 1,
    instanceId: INSTANCE_ID,
    domain: NEW_DOMAIN,
    publicKey: publicKeyField,
  });
  return JSON.stringify({
    instanceId: INSTANCE_ID,
    publicKey: publicKeyField,
    proof: signB64(docKey.privateKey, canonical),
  });
}

function changeBody(nonce = 'n'.repeat(16)): Record<string, unknown> {
  const timestamp = Math.floor(Date.now() / 1000);
  const canonicalChange = JSON.stringify({
    changeDomain: 1,
    instanceId: INSTANCE_ID,
    oldDomain: OLD_DOMAIN,
    newDomain: NEW_DOMAIN,
    timestamp,
    nonce,
  });
  return {
    instanceId: INSTANCE_ID,
    newDomain: NEW_DOMAIN,
    timestamp,
    nonce,
    oldKeySignature: signB64(stored.privateKey, canonicalChange),
  };
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request) => Promise<Response>;
  return handler(
    new Request('https://example.test/api/directory/change-domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  getRegistryInstanceByInstanceId.mockReset().mockResolvedValue({
    instanceId: INSTANCE_ID,
    domain: OLD_DOMAIN,
    ownerUserId: UID,
    publicKey: stored.publicDerB64,
    isListed: true,
    isVerified: true,
  });
  changeRegistryInstanceDomain.mockReset().mockResolvedValue(true);
  redisSet.mockReset().mockResolvedValue('OK');
  ssrfSafeGet.mockReset();
});

describe('POST /api/directory/change-domain — beta-review S10', () => {
  it('accepts a document carrying the STORED key and resets listing/verification', async () => {
    ssrfSafeGet.mockResolvedValue({ ok: true, status: 200, body: wellKnownFor(stored, stored.publicDerB64) });
    const res = await post(changeBody());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, domain: NEW_DOMAIN, isListed: false, isVerified: false });
    expect(changeRegistryInstanceDomain).toHaveBeenCalledWith(expect.anything(), {
      instanceId: INSTANCE_ID,
      ownerUserId: UID,
      newDomain: NEW_DOMAIN,
    });
  });

  it('accepts the same key in a different encoding (PEM document vs stored DER)', async () => {
    ssrfSafeGet.mockResolvedValue({ ok: true, status: 200, body: wellKnownFor(stored, stored.publicPem) });
    const res = await post(changeBody());
    expect(res.status).toBe(200);
  });

  it('REJECTS a self-consistent document signed with a DIFFERENT key', async () => {
    // The new domain vouches for itself with its own key pair — the proof
    // verifies against the document's key, but that key is not the
    // instance's registered key.
    ssrfSafeGet.mockResolvedValue({ ok: true, status: 200, body: wellKnownFor(attacker, attacker.publicDerB64) });
    const res = await post(changeBody());
    expect(res.status).toBe(401);
    expect(changeRegistryInstanceDomain).not.toHaveBeenCalled();
    // Rejected before the nonce is burned.
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('still requires the old-key signature over the change', async () => {
    ssrfSafeGet.mockResolvedValue({ ok: true, status: 200, body: wellKnownFor(stored, stored.publicDerB64) });
    const body = changeBody();
    body.oldKeySignature = signB64(attacker.privateKey, 'not the canonical payload');
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(changeRegistryInstanceDomain).not.toHaveBeenCalled();
  });
});
