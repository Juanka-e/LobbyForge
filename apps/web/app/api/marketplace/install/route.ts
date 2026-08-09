import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCatalogEntry, incrementDownloadCount } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { installPluginBundle } from '@/lib/plugin-installer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const InstallSchema = z.object({
  pluginId: z.string().min(2).max(128).regex(/^[a-z0-9][a-z0-9-_]*$/i, 'Plugin ID must be alphanumeric with dashes/underscores only'),
}).strict();

/**
 * POST /api/marketplace/install — download, extract, and validate an
 * approved marketplace plugin so the dynamic loader can pick it up.
 *
 * Admin-only (requireAdminHealthToken). Only works for plugins whose
 * reviewStatus is 'approved'. The bundle is downloaded from the
 * catalog entry's manifestUrl, verified (basic shape check), and
 * extracted to `plugins/installed/<pluginId>/`. The dynamic loader is
 * then reloaded so `getPlugin` resolves the new plugin immediately.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  // Dynamic plugin execution is disabled by default until process-level
  // isolation is implemented. This prevents untrusted code from running
  // in the web process.
  if (process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Dynamic plugin installation is disabled. Set LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true to enable (not recommended — plugins run in-process without isolation).' },
      { status: 503 }
    );
  }

  let body: z.infer<typeof InstallSchema>;
  try {
    body = InstallSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const db = getDb();
    const entry = await getCatalogEntry(db, body.pluginId);
    if (!entry) {
      return NextResponse.json({ error: 'Plugin not found in catalog' }, { status: 404 });
    }
    if (entry.reviewStatus !== 'approved') {
      return NextResponse.json(
        { error: `Plugin review status is "${entry.reviewStatus}" — only approved plugins can be installed.` },
        { status: 403 }
      );
    }
    if (!entry.manifestUrl) {
      return NextResponse.json(
        { error: 'Plugin has no manifestUrl — cannot download bundle.' },
        { status: 400 }
      );
    }

    const result = await installPluginBundle(body.pluginId, entry.manifestUrl, entry.version);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Bump the download count for analytics.
    await incrementDownloadCount(db, body.pluginId);

    return NextResponse.json({
      ok: true,
      pluginId: body.pluginId,
      version: entry.version,
      path: result.path,
      message: 'Plugin installed. It will be available for server-level enable.',
    });
  } catch (err) {
    console.error('[marketplace/install] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to install plugin' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 512,
  rateLimit: { identifier: 'marketplace-install', config: { windowMs: 60_000, maxRequests: 5 } },
});
