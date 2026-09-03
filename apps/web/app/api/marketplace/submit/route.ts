import { NextResponse } from 'next/server';
import { z } from 'zod';
import { submitPluginForReview } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SubmitSchema = z.object({
  pluginId: z.string().min(2).max(128).regex(/^[a-z0-9][a-z0-9-_]*$/i, 'Plugin ID must be alphanumeric with dashes/underscores only'),
  name: z.string().min(2).max(100),
  version: z.string().min(1).max(30),
  type: z.enum(['game', 'activity', 'utility']),
  summary: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  publisher: z.string().min(2).max(100),
  category: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  permissions: z.array(z.string().max(60)).max(20).optional(),
  playerConfig: z.record(z.unknown()).nullable().optional(),
  manifestUrl: z.string().url().refine((u) => u.startsWith('https://'), 'Manifest URL must use HTTPS').nullable().optional(),
  iconUrl: z.string().url().refine((u) => u.startsWith('https://'), 'Icon URL must use HTTPS').nullable().optional(),
  requiresVoiceRoom: z.boolean().optional(),
}).strict();

/**
 * POST /api/marketplace/submit — submit a plugin for marketplace review.
 * The caller must be authenticated. New submissions start with
 * reviewStatus='pending' and trustLevel='unverified' — an admin must
 * approve before the plugin appears publicly.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;

  let body: z.infer<typeof SubmitSchema>;
  try {
    body = SubmitSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const db = getDb();
    const entry = await submitPluginForReview(db, {
      ...body,
      // Force unverified on submit — admin can promote during review.
      trustLevel: 'unverified',
    }, uid);
    return NextResponse.json(
      {
        plugin: {
          pluginId: entry.pluginId,
          name: entry.name,
          reviewStatus: entry.reviewStatus,
        },
        message: 'Plugin submitted for review. An admin will review it before it appears in the marketplace.',
      },
      { status: 201 }
    );
  } catch (err) {
    // SEC-006: a plugin-ID takeover is a conflict, not a server error.
    if (err instanceof Error && err.name === 'PluginIdTakenError') {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('[marketplace/submit] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to submit plugin' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 8192,
  rateLimit: { identifier: 'marketplace-submit', config: { windowMs: 60_000, maxRequests: 5 } },
});
