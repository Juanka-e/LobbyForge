import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deletePluginInstall,
  getPluginInstall,
  listPluginInstallsForServer,
  logAction,
  upsertPluginInstall,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { listPluginSummaries, getPlugin } from '@/lib/plugin-registry';
import {
  CorePermission,
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
} from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AppSettingsSchema = z.object({
  allowedChannelIds: z.array(z.string().uuid()).optional(),
  allowedRoleIds: z.array(z.string().uuid()).optional(),
  defaultMaxPlayers: z.number().int().min(1).max(500).optional(),
  overflowPolicy: z.enum(['spectator', 'queue', 'split', 'reject']).optional(),
}).strict();

const UpsertAppSchema = z.object({
  pluginId: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  settings: AppSettingsSchema.optional(),
}).strict();

const DeleteAppSchema = z.object({
  pluginId: z.string().min(1).max(64),
}).strict();

function appSummary(input: {
  plugin: ReturnType<typeof listPluginSummaries>[number];
  install: Awaited<ReturnType<typeof getPluginInstall>>;
}) {
  return {
    ...input.plugin,
    installed: Boolean(input.install),
    enabled: input.install?.enabled ?? false,
    settings: input.install?.settings ?? {},
    installedAt: input.install?.createdAt.toISOString() ?? null,
  };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;

  const installs = await listPluginInstallsForServer(getDb(), serverId);
  const installByPlugin = new Map(installs.map((install) => [install.pluginId, install]));
  const apps = listPluginSummaries().map((plugin) =>
    appSummary({ plugin, install: installByPlugin.get(plugin.id) ?? null })
  );

  return NextResponse.json(
    { apps },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;
  const permission = await requireServerPermission(session.session.uid, serverId, CorePermission.MANAGE_SERVER);
  if (!permission.ok) return permission.response;

  let body: z.infer<typeof UpsertAppSchema>;
  try {
    body = UpsertAppSchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const plugin = getPlugin(body.pluginId);
  if (!plugin) {
    return NextResponse.json({ error: 'Unknown plugin' }, { status: 404 });
  }

  const install = await upsertPluginInstall(getDb(), {
    serverId,
    pluginId: plugin.manifest.id,
    enabled: body.enabled,
    settings: body.settings,
  });
  void logAction(getDb(), {
    serverId,
    actorUserId: session.session.uid,
    action: 'app.upsert',
    targetType: 'plugin',
    targetId: plugin.manifest.id,
    metadata: { enabled: install.enabled },
  }).catch((err) => console.error('[audit] app.upsert failed:', (err as Error).message));

  return NextResponse.json(
    { app: appSummary({ plugin: listPluginSummaries().find((p) => p.id === plugin.manifest.id)!, install }) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

async function handleDelete(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;
  const permission = await requireServerPermission(session.session.uid, serverId, CorePermission.MANAGE_SERVER);
  if (!permission.ok) return permission.response;

  let body: z.infer<typeof DeleteAppSchema>;
  try {
    body = DeleteAppSchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const plugin = getPlugin(body.pluginId);
  if (!plugin) {
    return NextResponse.json({ error: 'Unknown plugin' }, { status: 404 });
  }
  const deleted = await deletePluginInstall(getDb(), serverId, plugin.manifest.id);
  void logAction(getDb(), {
    serverId,
    actorUserId: session.session.uid,
    action: 'app.uninstall',
    targetType: 'plugin',
    targetId: plugin.manifest.id,
    metadata: { deleted },
  }).catch((err) => console.error('[audit] app.uninstall failed:', (err as Error).message));

  return NextResponse.json(
    { deleted },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-apps-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'server-apps-upsert', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-apps-delete', config: { windowMs: 60_000, maxRequests: 20 } },
});
