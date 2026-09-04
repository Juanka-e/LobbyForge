import { NextResponse } from 'next/server';
import { z } from 'zod';
import { RegistryInstanceOwnedError, upsertRegistryInstance } from '@lobbyforge/db';
import { normalizeRegistryInstanceUrl } from '@lobbyforge/registry';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RegisterSchema = z.object({
  instanceId: z.string().min(3).max(128),
  name: z.string().min(2).max(100),
  domain: z.string().min(3).max(253),
  description: z.string().max(500).nullable().optional(),
  region: z.string().max(60).nullable().optional(),
  languages: z.array(z.string()).max(20).optional(),
  tags: z.array(z.string()).max(30).optional(),
  features: z.array(z.string()).max(30).optional(),
  publicKey: z.string().min(32).max(512),
}).strict();

/**
 * POST /api/directory/register — register or update a self-hosted instance
 * in the discovery directory. The caller must be authenticated (the official
 * instance owner who controls registration). The domain is validated as an
 * HTTPS origin; new registrations start unlisted and unverified — an admin
 * must approve (set isListed + isVerified) before the instance appears
 * publicly.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  let body: z.infer<typeof RegisterSchema>;
  try {
    body = RegisterSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Validate the domain as a real HTTPS origin (rejects private IPs, etc.).
  let normalizedDomain: string;
  try {
    normalizedDomain = normalizeRegistryInstanceUrl(body.domain);
  } catch {
    return NextResponse.json({ error: 'Domain must be a valid HTTPS origin' }, { status: 400 });
  }

  try {
    const db = getDb();
    const instance = await upsertRegistryInstance(db, {
      instanceId: body.instanceId,
      name: body.name,
      domain: normalizedDomain,
      description: body.description ?? null,
      region: body.region ?? null,
      languages: body.languages ?? [],
      tags: body.tags ?? [],
      features: body.features ?? [],
      publicKey: body.publicKey,
      // SEC-007: only the first registrant may update the entry.
      actorUserId: sessionResult.session.uid,
    });
    return NextResponse.json(
      {
        instance: {
          instanceId: instance.instanceId,
          name: instance.name,
          domain: instance.domain,
          isListed: instance.isListed,
          isVerified: instance.isVerified,
        },
        message: instance.isListed
          ? 'Instance updated.'
          : 'Instance registered. An admin will review and list it.',
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof RegistryInstanceOwnedError) {
      return NextResponse.json(
        { error: 'This instance is registered by another user' },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: 'Failed to register instance' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'directory-register', config: { windowMs: 60_000, maxRequests: 5 } },
});
