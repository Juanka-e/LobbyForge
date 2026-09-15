import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getDirectoryVerificationConfig,
  setDirectoryVerificationConfig,
} from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/directory/config — read the current directory
 * verification configuration (proof, domain, publicKey, enabled).
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

async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  try {
    const config = await getDirectoryVerificationConfig(getDb());
    return NextResponse.json(
      { config: config ? {
        instanceId: config.instanceId,
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

  try {
    await setDirectoryVerificationConfig(getDb(), body);
    return NextResponse.json({ ok: true });
  } catch {
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
