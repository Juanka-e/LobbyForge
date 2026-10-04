/**
 * Slash commands (0044, docs/BOT_API_V2.md §3) — rows a bot registers with
 * `PUT /api/bot/v2/commands` and members run from the composer.
 *
 * A command name is unique per SERVER (`UNIQUE(server_id, name)`): a member
 * types `/roll`, so two bots of one server cannot both own it. The bot owns
 * `description`, `options`, `channel_ids` and `required_permission`; the
 * server's managers own `enabled` and `admin_channel_ids`, which a bot can
 * never reset: the row carries the effective values, and every manager
 * change is also kept in `bot_command_overrides` keyed by (bot, name) —
 * so a bot that DELETES a command and registers it again gets the
 * managers' switches back, not the defaults.
 *
 * Validation (name pattern, option shapes, caps) happens in the web app
 * before anything is written; the SQL CHECKs are the backstop.
 */
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { botCommandOverrides, botCommands, bots } from '../schema.js';
import { normalizeBotChannelAccessMode, type BotChannelAccessMode } from './botChannelAccess.js';

export interface BotCommandRow {
  id: string;
  botId: string;
  serverId: string;
  name: string;
  description: string;
  /** Validated option objects as stored (the web app owns the shape). */
  options: unknown[];
  /** null = every channel the bot can access. */
  channelIds: string[] | null;
  /** A manager's restriction; null = none. */
  adminChannelIds: string[] | null;
  requiredPermission: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A command plus the bot fields the member-side checks need. */
export interface ServerCommandRow extends BotCommandRow {
  bot: {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    permissions: string[];
    /** §1.1 mode — with the server's grants, decides which channels it reaches. */
    channelAccessMode: BotChannelAccessMode;
  };
}

export interface BotCommandInput {
  name: string;
  description: string;
  options: unknown[];
  channelIds: string[] | null;
  requiredPermission: string | null;
}

/** Thrown by `replaceBotCommands` when another bot of the server owns a name. */
export class CommandNameTakenError extends Error {
  constructor(readonly names: string[]) {
    super(`Command name(s) already taken in this server: ${names.join(', ')}`);
    this.name = 'CommandNameTakenError';
  }
}

const commandSelection = {
  id: botCommands.id,
  botId: botCommands.botId,
  serverId: botCommands.serverId,
  name: botCommands.name,
  description: botCommands.description,
  options: botCommands.options,
  channelIds: botCommands.channelIds,
  adminChannelIds: botCommands.adminChannelIds,
  requiredPermission: botCommands.requiredPermission,
  enabled: botCommands.enabled,
  createdAt: botCommands.createdAt,
  updatedAt: botCommands.updatedAt,
};

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * JSONB comes back as whatever was stored: a non-array `options` reads as
 * no options, a non-array channel list as "no restriction" only for the
 * bot's own list — never as a grant beyond what the access rule allows.
 */
function normalizeCommand(row: Record<string, unknown>): BotCommandRow {
  return {
    id: row.id as string,
    botId: row.botId as string,
    serverId: row.serverId as string,
    name: row.name as string,
    description: row.description as string,
    options: Array.isArray(row.options) ? (row.options as unknown[]) : [],
    channelIds: stringArrayOrNull(row.channelIds),
    adminChannelIds: stringArrayOrNull(row.adminChannelIds),
    requiredPermission: (row.requiredPermission as string | null) ?? null,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as Date,
    updatedAt: (row.updatedAt as Date | null) ?? (row.createdAt as Date),
  };
}

/** A bot's commands, by name. */
export async function listBotCommands(db: DbClient, botId: string): Promise<BotCommandRow[]> {
  const rows = await db.select(commandSelection).from(botCommands).where(eq(botCommands.botId, botId)).orderBy(asc(botCommands.name));
  return rows.map((row) => normalizeCommand(row as Record<string, unknown>));
}

export async function countBotCommands(db: DbClient, botId: string): Promise<number> {
  const rows = await db.select({ value: sql<number>`count(*)` }).from(botCommands).where(eq(botCommands.botId, botId));
  return Number(rows[0]?.value ?? 0);
}

export async function getBotCommandById(db: DbClient, commandId: string): Promise<BotCommandRow | null> {
  const rows = await db.select(commandSelection).from(botCommands).where(eq(botCommands.id, commandId)).limit(1);
  return rows[0] ? normalizeCommand(rows[0] as Record<string, unknown>) : null;
}

/** Every command of a server with its bot, in one query (the composer list). */
export async function listServerCommands(db: DbClient, serverId: string): Promise<ServerCommandRow[]> {
  const rows = await db
    .select({
      ...commandSelection,
      botName: bots.name,
      botType: bots.type,
      botEnabled: bots.enabled,
      botPermissions: bots.permissions,
      botChannelAccessMode: bots.channelAccessMode,
    })
    .from(botCommands)
    .innerJoin(bots, eq(bots.id, botCommands.botId))
    .where(eq(botCommands.serverId, serverId))
    .orderBy(asc(bots.name), asc(botCommands.name));
  return rows.map((row) => {
    const raw = row as Record<string, unknown>;
    const permissions = Array.isArray(raw.botPermissions)
      ? (raw.botPermissions as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    return {
      ...normalizeCommand(raw),
      bot: {
        id: raw.botId as string,
        name: raw.botName as string,
        type: raw.botType as string,
        enabled: Boolean(raw.botEnabled),
        permissions,
        channelAccessMode: normalizeBotChannelAccessMode(raw.botChannelAccessMode),
      },
    };
  });
}

/** Names in `names` that ANOTHER bot of the server already owns. */
export async function findCommandNamesTakenByOtherBots(
  db: DbClient,
  input: { serverId: string; botId: string; names: readonly string[] }
): Promise<string[]> {
  if (input.names.length === 0) return [];
  const rows = await db
    .select({ name: botCommands.name, botId: botCommands.botId })
    .from(botCommands)
    .where(and(eq(botCommands.serverId, input.serverId), inArray(botCommands.name, [...input.names])));
  return rows.filter((row) => row.botId !== input.botId).map((row) => row.name).sort();
}

/**
 * The managers' stored switch for (bot, name), as SQL for an INSERT: a
 * newly (re-)registered command starts from the override, not the default.
 */
function overrideEnabled(botId: string, name: string) {
  return sql`coalesce((select ${botCommandOverrides.enabled} from ${botCommandOverrides} where ${botCommandOverrides.botId} = ${botId} and ${botCommandOverrides.name} = ${name}), true)`;
}

function overrideAdminChannelIds(botId: string, name: string) {
  return sql`(select ${botCommandOverrides.adminChannelIds} from ${botCommandOverrides} where ${botCommandOverrides.botId} = ${botId} and ${botCommandOverrides.name} = ${name})`;
}

/**
 * Bulk overwrite a bot's commands (the Bot API's `PUT /commands`): names
 * not in the list are deleted, existing names are updated in place (their
 * id, `enabled` and `admin_channel_ids` survive), new names are inserted
 * with the managers' stored switches for that name (`bot_command_overrides`)
 * — so deleting a command and registering it again changes nothing for the
 * managers. One transaction; if another bot of the server owns a name —
 * including one taken by a concurrent request — nothing is written and
 * `CommandNameTakenError` is thrown.
 */
export async function replaceBotCommands(
  db: DbClient,
  input: { botId: string; serverId: string; commands: readonly BotCommandInput[] },
  now: Date = new Date()
): Promise<BotCommandRow[]> {
  const names = input.commands.map((c) => c.name);
  await db.transaction(async (tx) => {
    if (names.length === 0) {
      await tx.delete(botCommands).where(eq(botCommands.botId, input.botId));
      return;
    }
    await tx.delete(botCommands).where(and(eq(botCommands.botId, input.botId), notInArray(botCommands.name, names)));
    const taken: string[] = [];
    for (const command of input.commands) {
      // The update only applies to this bot's own row: on a name owned by
      // another bot the WHERE fails, nothing is returned, and the whole
      // transaction is rolled back below.
      const written = await tx
        .insert(botCommands)
        .values({
          botId: input.botId,
          serverId: input.serverId,
          name: command.name,
          description: command.description,
          options: command.options,
          channelIds: command.channelIds,
          requiredPermission: command.requiredPermission,
          enabled: overrideEnabled(input.botId, command.name),
          adminChannelIds: overrideAdminChannelIds(input.botId, command.name),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [botCommands.serverId, botCommands.name],
          set: {
            description: command.description,
            options: command.options,
            channelIds: command.channelIds,
            requiredPermission: command.requiredPermission,
            updatedAt: now,
          },
          setWhere: sql`${botCommands.botId} = ${input.botId}`,
        })
        .returning({ id: botCommands.id });
      if (written.length === 0) taken.push(command.name);
    }
    if (taken.length > 0) throw new CommandNameTakenError(taken.sort());
  });
  return listBotCommands(db, input.botId);
}

/**
 * Remove one of a bot's commands by name. The managers' override for the
 * name stays: registering it again restores their switches.
 */
export async function deleteBotCommandByName(db: DbClient, botId: string, name: string): Promise<boolean> {
  const deleted = await db
    .delete(botCommands)
    .where(and(eq(botCommands.botId, botId), eq(botCommands.name, name)))
    .returning({ id: botCommands.id });
  return deleted.length > 0;
}

/**
 * A manager's switches on one command (never the bot's own fields). One
 * transaction: the row gets the new effective values and
 * `bot_command_overrides` (bot, name) records the resulting state, so it
 * outlives the row if the bot deletes and re-registers the command.
 */
export async function updateBotCommandAdmin(
  db: DbClient,
  commandId: string,
  patch: { enabled?: boolean; adminChannelIds?: string[] | null; updatedBy?: string | null },
  now: Date = new Date()
): Promise<BotCommandRow | null> {
  const set: Record<string, unknown> = { updatedAt: now };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.adminChannelIds !== undefined) set.adminChannelIds = patch.adminChannelIds;
  const written = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(botCommands)
      .set(set)
      .where(eq(botCommands.id, commandId))
      .returning({
        botId: botCommands.botId,
        name: botCommands.name,
        enabled: botCommands.enabled,
        adminChannelIds: botCommands.adminChannelIds,
      });
    if (!row) return false;
    const state = {
      enabled: Boolean(row.enabled),
      adminChannelIds: stringArrayOrNull(row.adminChannelIds),
      updatedBy: patch.updatedBy ?? null,
      updatedAt: now,
    };
    await tx
      .insert(botCommandOverrides)
      .values({ botId: row.botId, name: row.name, ...state })
      .onConflictDoUpdate({ target: [botCommandOverrides.botId, botCommandOverrides.name], set: state });
    return true;
  });
  if (!written) return null;
  return getBotCommandById(db, commandId);
}
