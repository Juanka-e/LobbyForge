import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deletePluginInstall,
  getChannelById,
  getPluginInstall,
  isChannelOpenToBots,
  listPluginInstallsForServer,
  logAction,
  upsertPluginInstall,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getPluginServer, listPluginSummariesServer } from '@/lib/plugin-server-registry';
import { effectGrantFor } from '@/lib/activity-effects';
import { APP_MESSAGE_CHANNEL_TYPES } from '@/lib/activity-app-chat';
import { endAppSessions } from '@/lib/activity-app-install';
import { canGrantGatedChannels } from '@/lib/bots/access';
import { authorizeChannelVisibility } from '@/lib/permissions';
import { pluginName, pluginSummary } from '@/lib/plugin-catalog-text';
import { localeFromRequest } from '@/lib/i18n/server';
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
  /**
   * Where the app's chat posts go (`chat.post`, lib/activity-app-chat.ts):
   * a text or announcement channel of this community. Absent or null: the
   * app posts nowhere.
   */
  chatChannelId: z.string().uuid().nullable().optional(),
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
  plugin: ReturnType<typeof listPluginSummariesServer>[number];
  install: Awaited<ReturnType<typeof getPluginInstall>>;
  locale: string;
}) {
  // The description in the viewer's language, resolved HERE: the clients
  // that render this list run pluginSummary in the browser, which knows the
  // compiled-in plugins' tables but not a marketplace bundle's locales/.
  const summary = pluginSummary(input.plugin.id, input.locale, input.plugin.catalog?.summary ?? null);
  const registered = getPluginServer(input.plugin.id);
  return {
    ...input.plugin,
    // The plugin's own catalog.name in the viewer's language ("Poll" → "Anket").
    name: pluginName(input.plugin.id, input.locale, input.plugin.name),
    // The host effects it may use (a marketplace plugin's: only what the owner approved).
    effectPermissions: registered ? effectGrantFor(registered).permissions : [],
    catalog: summary !== null ? { ...(input.plugin.catalog ?? {}), summary } : input.plugin.catalog,
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
  const locale = await localeFromRequest(req);
  const apps = listPluginSummariesServer().map((plugin) =>
    appSummary({ plugin, install: installByPlugin.get(plugin.id) ?? null, locale })
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

  const plugin = getPluginServer(body.pluginId);
  if (!plugin) {
    return NextResponse.json({ error: 'Unknown plugin' }, { status: 404 });
  }
  const chatChannelId = body.settings?.chatChannelId;
  if (typeof chatChannelId === 'string') {
    const channel = await getChannelById(getDb(), chatChannelId);
    if (!channel || channel.serverId !== serverId || !APP_MESSAGE_CHANNEL_TYPES.has(channel.type)) {
      return NextResponse.json(
        { error: 'App messages can only go to a text or announcement channel of this community', code: 'invalid_chat_channel' },
        { status: 400 }
      );
    }
    // Pointing an app's messages at a role-gated channel takes what granting
    // a bot one takes (lib/bots/access.ts `canGrantGatedChannels`): Manage
    // Channels, and seeing the channel. Otherwise a member with only Manage
    // Server could have a game write into a private channel they cannot
    // read. Checked when the channel changes: saving other settings of an
    // app whose channel someone else chose keeps it as it is.
    const existing = await getPluginInstall(getDb(), serverId, plugin.manifest.id);
    const storedChannelId =
      existing?.settings && typeof existing.settings === 'object'
        ? (existing.settings as Record<string, unknown>).chatChannelId
        : undefined;
    if (chatChannelId !== storedChannelId) {
      const uid = session.session.uid;
      const ownerUserId = member.server?.ownerUserId ?? null;
      const gated = !(await isChannelOpenToBots(getDb(), chatChannelId));
      const mayUseGated = canGrantGatedChannels({ uid, isOwner: ownerUserId === uid, permissions: permission.permissions });
      const visible = (await authorizeChannelVisibility(uid, serverId, chatChannelId, ownerUserId)).ok;
      if ((gated && !mayUseGated) || !visible) {
        return NextResponse.json(
          {
            error: 'Only a member with Manage Channels can send app messages to a private channel',
            code: 'chat_channel_not_allowed',
          },
          { status: 403 }
        );
      }
    }
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
  // A disabled app runs nothing: its open sessions end (audited per session).
  if (!install.enabled) {
    await endAppSessions(getDb(), {
      serverId,
      pluginId: plugin.manifest.id,
      actorUserId: session.session.uid,
      reason: 'app_disabled',
    }).catch((err) => console.error('[apps] ending the disabled app’s sessions failed:', (err as Error).message));
  }

  return NextResponse.json(
    {
      app: appSummary({
        plugin: listPluginSummariesServer().find((p) => p.id === plugin.manifest.id)!,
        install,
        locale: await localeFromRequest(req),
      }),
    },
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

  const plugin = getPluginServer(body.pluginId);
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
  // An uninstalled app runs nothing: its open sessions end (audited per
  // session). Done whether or not a row was deleted — a session can outlive
  // an install that is already gone.
  await endAppSessions(getDb(), {
    serverId,
    pluginId: plugin.manifest.id,
    actorUserId: session.session.uid,
    reason: 'app_uninstalled',
  }).catch((err) => console.error('[apps] ending the uninstalled app’s sessions failed:', (err as Error).message));

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
