import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCatalogEntry, getInstanceBootstrapStatus, incrementDownloadCount, logAction } from '@lobbyforge/db';
import { readGuestSession } from '@/lib/guest-session';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { installPluginBundle } from '@/lib/plugin-installer';
import { parseApprovals, sandboxManifestOptions, type PluginApprovals } from '@/lib/plugin-approvals';
import { isOfficialPluginId, officialPluginIdError } from '@/lib/official-plugin-ids';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const InstallSchema = z.object({
  pluginId: z.string().min(2).max(128).regex(/^[a-z0-9][a-z0-9-_]*$/i, 'Plugin ID must be alphanumeric with dashes/underscores only'),
  /** What the owner approved: exactly what the bundle asks for (plugin-approvals.ts). */
  approve: z.unknown().optional(),
}).strict();

function actorUserId(req: Request): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  // Null for the emergency admin token: there is no account behind it.
  return readGuestSession(req.headers.get('cookie'), secret)?.uid ?? null;
}

/** Filed under the instance's community (the first server), like the other instance settings. */
async function auditInstall(req: Request, pluginId: string, version: string, approved: PluginApprovals | null): Promise<void> {
  try {
    const setup = await getInstanceBootstrapStatus(getDb());
    await logAction(getDb(), {
      serverId: setup.firstServerId ?? null,
      actorUserId: actorUserId(req),
      action: 'plugin.install',
      targetType: 'plugin',
      targetId: pluginId,
      metadata: { version, approved },
    });
  } catch (err) {
    console.error('[marketplace/install] audit log write failed', JSON.stringify((err as Error).message));
  }
}

/**
 * POST /api/marketplace/install — download, extract, and validate an
 * approved marketplace plugin so the dynamic loader can pick it up.
 *
 * Admin-only (requireAdminHealthToken). Only works for plugins whose
 * reviewStatus is 'approved'. The bundle is downloaded from the
 * catalog entry's manifestUrl, verified against the reviewed SHA-256
 * pin and extracted to `<LOBBYFORGE_PLUGIN_INSTALL_DIR>/<pluginId>/<version>/`.
 * The plugin-worker must load that exact version before it is recorded
 * as active; the registry then serves it and older versions are deleted
 * (plugin-installer.ts, plugin-install-layout.ts).
 *
 * A bundle that asks for more than the sandbox (outside origins, its own
 * site as the UI, host effects) is refused with 409 `approval_required`
 * and what it asks for (`requested`, plus `added`: what the active version
 * had not approved). The owner's screen shows that and sends the request
 * again with `approve` naming exactly the same — nothing is approved
 * silently, and an upgrade that asks for more asks again.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  // Dynamic plugin execution is opt-in. When enabled, bundles run only in
  // the isolated plugin-worker container (LF-SEC-010), never in the web
  // process — the old message here still said "in-process".
  if (process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Dynamic plugin installation is disabled. Set LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true to enable it; plugins then run only in the plugin-worker, sandboxed in a QuickJS VM (ADR-007).' },
      { status: 503 }
    );
  }

  let body: z.infer<typeof InstallSchema>;
  try {
    body = InstallSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const approve = parseApprovals(body.approve, sandboxManifestOptions());
  if (body.approve !== undefined && body.approve !== null && !approve) {
    return NextResponse.json({ error: 'Invalid approval', code: 'invalid_approval' }, { status: 400 });
  }
  // An official plugin's id is never a marketplace install, whatever the
  // catalogue says (official-plugin-ids.ts; the installer refuses it too).
  if (isOfficialPluginId(body.pluginId)) {
    return NextResponse.json(
      { error: officialPluginIdError(body.pluginId), code: 'reserved_plugin_id' },
      { status: 409 }
    );
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
    // 14th-audit: FAIL CLOSED — an approved row without an artifact pin
    // means "approved" predates the pinned model; the mutable-URL trust
    // gap applies. Re-review (which now pins) is required first.
    if (!entry.bundleSha256 || entry.bundleSizeBytes == null) {
      return NextResponse.json(
        { error: 'This plugin was approved before artifact pinning and must be re-reviewed before installation.' },
        { status: 409 }
      );
    }
    if (!entry.manifestUrl) {
      return NextResponse.json(
        { error: 'Plugin has no manifestUrl — cannot download bundle.' },
        { status: 400 }
      );
    }

    // 13th-audit: pass the REVIEWED pin so the installer verifies the
    // downloaded bytes against what approval actually reviewed.
    const result = await installPluginBundle(
      body.pluginId,
      entry.manifestUrl,
      entry.version,
      entry.bundleSha256 && entry.bundleSizeBytes != null
        ? { sha256: entry.bundleSha256, sizeBytes: entry.bundleSizeBytes }
        : undefined,
      approve
    );
    if (!result.ok && result.approvalRequired) {
      return NextResponse.json(
        { error: result.error, code: 'approval_required', pluginId: body.pluginId, version: entry.version, ...result.approvalRequired },
        { status: 409 }
      );
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    await auditInstall(req, body.pluginId, entry.version, result.approved ?? null);

    // Bump the download count for analytics.
    await incrementDownloadCount(db, body.pluginId);

    return NextResponse.json({
      ok: true,
      pluginId: body.pluginId,
      version: entry.version,
      path: result.path,
      approved: result.approved ?? null,
      message: 'Plugin installed. It will be available for server-level enable.',
    });
  } catch (err) {
    console.error('[marketplace/install] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to install plugin' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  // The approval repeats what the bundle asks for: up to 32 origins and a URL.
  maxBodyBytes: 16 * 1024,
  rateLimit: { identifier: 'marketplace-install', config: { windowMs: 60_000, maxRequests: 5 } },
});
