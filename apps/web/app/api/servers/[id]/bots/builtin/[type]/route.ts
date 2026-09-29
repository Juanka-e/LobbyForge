import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureBuiltInBot, updateBot, type BuiltInBotType, type UpdateBotInput } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import {
  auditBotAction,
  BotNameSchema,
  invalidBody,
  jsonErrors,
  requireBotManager,
  settingsAuditSummary,
  toBotJson,
} from '@/lib/bots/admin';
import { invalidateBotCache } from '@/lib/bots/cache';
import { BUILT_IN_BOT_PERMISSIONS, isBuiltInType } from '@/lib/bots/permissions';
import { resolveBotChannel } from '@/lib/bots/messages';
import {
  ModerationSettingsInputSchema,
  WelcomeSettingsInputSchema,
  parseModerationSettings,
  parseWelcomeSettings,
} from '@/lib/bots/settings';
import { defaultBotText } from '@/lib/bots/templates';
import { CorePermission, hasPermission } from '@lobbyforge/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; type: string }> };

const BodySchema = z
  .object({
    enabled: z.boolean().optional(),
    name: BotNameSchema.optional(),
    settings: z.unknown().optional(),
  })
  .strict();

const DEFAULT_NAME_KEY = {
  welcome: 'bots.welcome.defaultName',
  moderation: 'bots.moderation.defaultName',
} as const;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * PUT — set up or configure the server's Welcome / Moderation bot. The
 * first call creates the bot; later calls update it. Settings are merged
 * over what is stored; the permission set is always the built-in one.
 */
async function handlePut(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, type } = await ctx.params;
  if (!isBuiltInType(type)) {
    return NextResponse.json({ error: 'Unknown built-in bot', code: 'not_found' }, { status: 404 });
  }
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const { manager } = auth;
  // A bot acts with the powers it was given: switching on the one that
  // removes members' messages takes the right to remove them yourself.
  if (type === 'moderation' && !manager.isOwner && !hasPermission([...manager.permissions], CorePermission.MANAGE_MESSAGES)) {
    return NextResponse.json({ error: 'Forbidden', code: 'missing_permission' }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const body = parsed.data;

  let settingsPatch: Record<string, unknown> = {};
  if (body.settings !== undefined) {
    const schema = type === 'welcome' ? WelcomeSettingsInputSchema : ModerationSettingsInputSchema;
    const settings = schema.safeParse(body.settings);
    if (!settings.success) {
      return invalidBody(settings.error.issues.map((issue) => ({ ...issue, path: ['settings', ...issue.path] })));
    }
    settingsPatch = Object.fromEntries(
      Object.entries(settings.data as Record<string, unknown>).filter(([, value]) => value !== undefined)
    );
  }

  if (type === 'welcome' && typeof settingsPatch.channelId === 'string') {
    const channel = await resolveBotChannel(
      { id: 'welcome', serverId, name: '', type, enabled: true, permissions: [] },
      settingsPatch.channelId
    );
    if (!channel.ok) {
      return NextResponse.json(
        { error: 'Pick a text channel of this server that every member can see', code: 'invalid_channel' },
        { status: 400 }
      );
    }
  }

  const botType = type as BuiltInBotType;
  const parse = type === 'welcome' ? parseWelcomeSettings : parseModerationSettings;
  const permissions = [...BUILT_IN_BOT_PERMISSIONS[botType]];
  const { bot, created } = await ensureBuiltInBot(getDb(), {
    serverId,
    type: botType,
    name: body.name ?? defaultBotText(DEFAULT_NAME_KEY[botType]),
    permissions,
    settings: { ...parse({}), ...settingsPatch },
    enabled: body.enabled ?? true,
    createdBy: manager.uid,
  });

  if (created) {
    invalidateBotCache(serverId);
    auditBotAction({
      serverId,
      actorUserId: manager.uid,
      action: 'bot.create',
      bot,
      metadata: { enabled: bot.enabled, settings: settingsAuditSummary(type, bot.settings) },
    });
    return NextResponse.json(
      { bot: toBotJson(bot, { includeSettings: true }), created: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const patch: UpdateBotInput = {};
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined && body.name !== bot.name) {
    patch.name = body.name;
    changes.name = { from: bot.name, to: body.name };
  }
  if (body.enabled !== undefined && body.enabled !== bot.enabled) {
    patch.enabled = body.enabled;
    changes.enabled = body.enabled;
  }
  const mergedSettings = { ...parse(bot.settings), ...settingsPatch };
  if (!sameJson(mergedSettings, parse(bot.settings))) {
    patch.settings = mergedSettings;
    changes.settings = settingsAuditSummary(type, mergedSettings);
  }
  // Self-heal: a built-in bot always carries exactly its fixed permissions.
  if (!sameJson([...bot.permissions].sort(), [...permissions].sort())) patch.permissions = permissions;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { bot: toBotJson(bot, { includeSettings: true }), created: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const updated = await updateBot(getDb(), bot.id, patch);
  if (!updated) return NextResponse.json({ error: 'Bot not found', code: 'not_found' }, { status: 404 });
  invalidateBotCache(serverId);
  if (Object.keys(changes).length > 0) {
    const onlyToggle = Object.keys(changes).length === 1 && 'enabled' in changes;
    auditBotAction({
      serverId,
      actorUserId: manager.uid,
      action: onlyToggle ? (patch.enabled ? 'bot.enable' : 'bot.disable') : 'bot.update',
      bot: updated,
      metadata: onlyToggle ? {} : { changes },
    });
  }
  return NextResponse.json(
    { bot: toBotJson(updated, { includeSettings: true }), created: false },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const PUT = withApiSecurity(jsonErrors('configure built-in bot', handlePut), {
  allowedMethods: ['PUT'],
  maxBodyBytes: 96 * 1024,
  rateLimit: { identifier: 'server-bots-builtin', config: { windowMs: 60_000, maxRequests: 30 } },
});
