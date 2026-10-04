/**
 * Shared pieces of the bot administration routes
 * (`/api/servers/{id}/bots/**`): who may manage bots, how a bot is shown,
 * and the audit entry every change writes.
 *
 * Managing bots needs MANAGE_SERVER (administrators and the owner hold it
 * implicitly). A member may LIST the server's bots — the BOT badge and the
 * bot profile are public inside the server — but only a manager sees a
 * bot's settings (a member must not read the blocked-word list).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getServerById, logAction, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession, type ApiResult } from '@/lib/api-auth';
import { authorizeServerPermission } from '@/lib/permissions';
import { BOT_NAME_MAX_LENGTH, botTrustLevel, isBuiltInType, type BotTrustLevel } from './catalog';
import { parseModerationSettings, parseWelcomeSettings } from './settings';

/**
 * A bot's display name: 1–32 characters, whitespace collapsed, no control
 * or format characters — the latter include bidi overrides and isolates
 * (U+202A–202E, U+2066–2069), U+061C and zero-width characters, which can
 * make a name render as something else (same rule as webhook usernames).
 */
export const BotNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Name is required')
      .max(BOT_NAME_MAX_LENGTH, `Name must be at most ${BOT_NAME_MAX_LENGTH} characters`)
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'Name must not contain control characters')
  );

/**
 * Run a route handler and turn an unexpected throw into a JSON 500
 * (the security wrapper does not catch).
 */
export function jsonErrors<TArgs extends unknown[]>(
  label: string,
  handler: (...args: TArgs) => Promise<NextResponse>
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[bots] ${label} failed:`, (err as Error).message);
      return NextResponse.json({ error: 'Internal error', code: 'internal_error' }, { status: 500 });
    }
  };
}

export interface BotJson {
  id: string;
  serverId: string;
  name: string;
  type: string;
  builtIn: boolean;
  permissions: string[];
  enabled: boolean;
  trustLevel: BotTrustLevel;
  tokenConfigured: boolean;
  tokenIssuedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only for managers. */
  settings?: Record<string, unknown>;
}

export function botSettingsJson(row: Pick<BotRow, 'type' | 'settings'>): Record<string, unknown> {
  if (row.type === 'welcome') return { ...parseWelcomeSettings(row.settings) };
  if (row.type === 'moderation') return { ...parseModerationSettings(row.settings) };
  return {};
}

/** Never includes the token hash. */
export function toBotJson(row: BotRow, options: { includeSettings: boolean }): BotJson {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    type: row.type,
    builtIn: isBuiltInType(row.type),
    permissions: row.permissions,
    enabled: row.enabled,
    trustLevel: botTrustLevel(row.type),
    tokenConfigured: Boolean(row.tokenHash),
    tokenIssuedAt: row.tokenIssuedAt ? row.tokenIssuedAt.toISOString() : null,
    createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName } : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(options.includeSettings ? { settings: botSettingsJson(row) } : {}),
  };
}

export interface BotManager {
  uid: string;
  server: { id: string; ownerUserId: string; name: string };
  permissions: string[];
  isOwner: boolean;
}

/** Signed-in member of an existing server holding MANAGE_SERVER. */
export async function requireBotManager(req: Request, serverId: string): Promise<ApiResult<{ manager: BotManager }>> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session;
  const server = await getServerById(getDb(), serverId);
  if (!server) return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  const auth = await authorizeServerPermission(session.session.uid, serverId, CorePermission.MANAGE_SERVER);
  if (!auth.ok) return { ok: false, response: auth.response };
  return {
    ok: true,
    manager: {
      uid: session.session.uid,
      server: { id: server.id, ownerUserId: server.ownerUserId, name: server.name },
      permissions: auth.permissions,
      isOwner: server.ownerUserId === session.session.uid,
    },
  };
}

export function canManageBots(permissions: readonly string[]): boolean {
  return hasPermission([...permissions], CorePermission.MANAGE_SERVER);
}

/** One audit row per bot change. Never carries a token or its hash. */
export function auditBotAction(input: {
  serverId: string;
  actorUserId: string;
  action: string;
  bot: Pick<BotRow, 'id' | 'name' | 'type'>;
  metadata?: Record<string, unknown>;
}): void {
  void logAction(getDb(), {
    serverId: input.serverId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: 'bot',
    targetId: input.bot.id,
    metadata: { name: input.bot.name, type: input.bot.type, ...(input.metadata ?? {}) },
  }).catch((err) => console.error(`[audit] ${input.action} failed:`, (err as Error).message));
}

/** 400 with the zod issues flattened to readable strings. */
export function invalidBody(issues: Array<{ path: (string | number)[]; message: string }>): NextResponse {
  return NextResponse.json(
    {
      error: 'Invalid request body',
      code: 'invalid_request',
      issues: issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
    },
    { status: 400 }
  );
}

/** A summary of settings for the audit log — counts, not the word list. */
export function settingsAuditSummary(type: string, settings: Record<string, unknown>): Record<string, unknown> {
  if (type === 'moderation') {
    const parsed = parseModerationSettings(settings);
    return {
      blockedWords: parsed.blockedWords.length,
      linkPolicy: parsed.linkPolicy,
      allowedDomains: parsed.allowedDomains.length,
      maxMentions: parsed.maxMentions,
      flood: parsed.flood,
      repeat: parsed.repeat,
      exemptStaff: parsed.exemptStaff,
      postNotice: parsed.postNotice,
    };
  }
  if (type === 'welcome') {
    const parsed = parseWelcomeSettings(settings);
    return { channelId: parsed.channelId, customTemplate: parsed.template !== null };
  }
  return {};
}
