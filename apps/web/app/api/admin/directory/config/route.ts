import { NextResponse } from 'next/server';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import {
  DirectoryConfigNotInitializedError,
  getDirectoryVerificationConfig,
  setDirectoryVerificationConfig,
} from '@lobbyforge/db';
import { normalizeRegistryInstanceUrl } from '@lobbyforge/registry';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/directory/config — read the current directory
 * verification configuration (proof, domain, publicKey, enabled) and
 * `instanceId`: this install's directory id, the value to pass to
 * `lfctl directory proof --instance-id` and to register under.
 *
 * POST /api/admin/directory/config — atomically configure the
 * directory verification (owner-only). The operator generates the
 * proof with `lfctl directory proof` and submits it here; the
 * .well-known endpoint starts serving it immediately.
 */
const ConfigureSchema = z.object({
  domain: z.string().min(3).max(253),
  publicKey: z.string().min(32).max(512),
  directoryProof: z.string().min(64).max(512),
  isPublicDirectoryEnabled: z.boolean(),
}).strict();

const NOT_INITIALISED = 'Instance settings are not initialised — finish /setup first.';

function parsePublicKeyPemOrDer(stored: string): ReturnType<typeof createPublicKey> | null {
  try {
    if (stored.includes('-----BEGIN')) return createPublicKey(stored);
    return createPublicKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * security-review HUB-001: does the proof sign THIS install's directory id?
 * The same canonical payload the directory checks on registration, so a
 * proof made for the shared settings key (`self-host`) or another install
 * is refused here, with the right id in the answer, instead of failing
 * later at the hub.
 */
function proofCoversDirectoryId(input: {
  directoryInstanceId: string;
  domain: string;
  publicKey: string;
  proof: string;
}): boolean {
  const key = parsePublicKeyPemOrDer(input.publicKey);
  if (!key) return false;
  const canonical = JSON.stringify({
    verify: 1,
    instanceId: input.directoryInstanceId,
    domain: input.domain,
    publicKey: input.publicKey,
  });
  try {
    return edVerify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(input.proof, 'base64'));
  } catch {
    return false;
  }
}

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  try {
    const config = await getDirectoryVerificationConfig(getDb());
    return NextResponse.json(
      { config: config ? {
        // security-review HUB-001: the install's directory id, not the
        // settings singleton key every install shares.
        instanceId: config.directoryInstanceId,
        domain: config.domain,
        publicKey: config.publicKey,
        isPublicDirectoryEnabled: config.isPublicDirectoryEnabled,
        hasProof: !!config.directoryProof,
      } : null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load directory config' }, { status: 500 });
  }
}

async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;

  let body: z.infer<typeof ConfigureSchema>;
  try {
    body = ConfigureSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // The directory proves the domain exactly as it normalises it, so a
  // stored proof over any other spelling could never verify there.
  let domain: string;
  try {
    domain = normalizeRegistryInstanceUrl(body.domain);
  } catch {
    return NextResponse.json({ error: 'domain must be a public HTTPS origin, e.g. https://chat.example.com' }, { status: 400 });
  }
  if (domain !== body.domain) {
    return NextResponse.json(
      { error: `domain must be written as its origin: ${domain} (no path or trailing slash). Re-run lfctl directory proof with --url ${domain}.` },
      { status: 400 }
    );
  }

  try {
    const current = await getDirectoryVerificationConfig(getDb());
    if (!current) {
      return NextResponse.json({ error: NOT_INITIALISED }, { status: 409 });
    }
    if (
      !proofCoversDirectoryId({
        directoryInstanceId: current.directoryInstanceId,
        domain,
        publicKey: body.publicKey,
        proof: body.directoryProof,
      })
    ) {
      return NextResponse.json(
        {
          error: `directoryProof does not sign this instance's directory id, domain and publicKey. Run: lfctl directory proof --instance-id ${current.directoryInstanceId} --url ${domain} --key-file <private-key.pem>`,
          instanceId: current.directoryInstanceId,
        },
        { status: 400 }
      );
    }
    // security-review HUB-001: the setter throws when it updates no row —
    // this route used to answer { ok: true } after writing nothing.
    const saved = await setDirectoryVerificationConfig(getDb(), { ...body, domain });
    return NextResponse.json({ ok: true, instanceId: saved.directoryInstanceId });
  } catch (err) {
    if (err instanceof DirectoryConfigNotInitializedError) {
      return NextResponse.json({ error: NOT_INITIALISED }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to save directory config' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-directory-config-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'admin-directory-config-post', config: { windowMs: 60_000, maxRequests: 5 } },
});
