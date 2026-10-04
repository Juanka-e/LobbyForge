/**
 * Slash commands (docs/BOT_API_V2.md §3.1, §3.3) — the server-side shapes
 * and checks. The composer has a client-side copy of the option check
 * (`command-options.ts`) for instant feedback; THIS is the boundary: every
 * registration and every invocation is validated here, never trusted from
 * a client or a bot.
 */
import { z } from 'zod';
import { CorePermission } from '@lobbyforge/core';
import type { BotCommandRow } from '@lobbyforge/db';
import {
  COMMAND_DESCRIPTION_MAX_LENGTH,
  COMMAND_NAME_PATTERN,
  COMMAND_STRING_OPTION_MAX_LENGTH,
  MAX_COMMAND_OPTIONS,
  MAX_COMMANDS_PER_BOT,
  MAX_OPTION_CHOICES,
} from './catalog';

export const COMMAND_OPTION_TYPES = ['string', 'integer', 'number', 'boolean', 'user', 'channel'] as const;
export type CommandOptionType = (typeof COMMAND_OPTION_TYPES)[number];

/** Every core permission id a command may require of its invoker. */
export const COMMAND_REQUIRABLE_PERMISSIONS = Object.values(CorePermission) as [string, ...string[]];

export interface CommandOptionChoice {
  name: string;
  value: string | number;
}

/** A stored, normalised option. */
export interface CommandOption {
  name: string;
  description: string;
  type: CommandOptionType;
  required: boolean;
  min?: number;
  max?: number;
  choices?: CommandOptionChoice[];
}

const CHOICE_NAME_MAX_LENGTH = 100;
const CHOICE_STRING_VALUE_MAX_LENGTH = 100;

const NameSchema = z
  .string()
  .regex(COMMAND_NAME_PATTERN, 'must be 1–32 characters: lowercase letters, digits, "_" or "-"');

const ChoiceSchema = z
  .object({
    name: z.string().trim().min(1).max(CHOICE_NAME_MAX_LENGTH),
    value: z.union([z.string().min(1).max(CHOICE_STRING_VALUE_MAX_LENGTH), z.number().finite()]),
  })
  .strict();

const OptionSchema = z
  .object({
    name: NameSchema,
    description: z.string().trim().max(COMMAND_DESCRIPTION_MAX_LENGTH).optional(),
    type: z.enum(COMMAND_OPTION_TYPES),
    required: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    choices: z.array(ChoiceSchema).min(1).max(MAX_OPTION_CHOICES).optional(),
  })
  .strict()
  .superRefine((option, ctx) => {
    const numeric = option.type === 'integer' || option.type === 'number';
    if ((option.min !== undefined || option.max !== undefined) && !numeric) {
      ctx.addIssue({ code: 'custom', message: 'min/max are only for integer and number options' });
    }
    if (option.type === 'integer') {
      for (const bound of ['min', 'max'] as const) {
        const value = option[bound];
        if (value !== undefined && !Number.isInteger(value)) {
          ctx.addIssue({ code: 'custom', path: [bound], message: `${bound} must be an integer` });
        }
      }
    }
    if (option.min !== undefined && option.max !== undefined && option.min > option.max) {
      ctx.addIssue({ code: 'custom', message: 'min must not be greater than max' });
    }
    if (option.choices) {
      if (!(option.type === 'string' || numeric)) {
        ctx.addIssue({ code: 'custom', path: ['choices'], message: 'choices are only for string, integer and number options' });
        return;
      }
      const seen = new Set<string>();
      option.choices.forEach((choice, index) => {
        const wrongType =
          option.type === 'string'
            ? typeof choice.value !== 'string'
            : typeof choice.value !== 'number' || (option.type === 'integer' && !Number.isInteger(choice.value));
        if (wrongType) {
          ctx.addIssue({ code: 'custom', path: ['choices', index, 'value'], message: `must be a valid ${option.type}` });
        }
        const key = String(choice.value);
        if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['choices', index, 'value'], message: 'duplicate choice' });
        seen.add(key);
      });
    }
  });

export const CommandInputSchema = z
  .object({
    name: NameSchema,
    description: z.string().trim().min(1).max(COMMAND_DESCRIPTION_MAX_LENGTH),
    options: z.array(OptionSchema).max(MAX_COMMAND_OPTIONS).optional(),
    channelIds: z.array(z.string().uuid()).min(1).max(500).nullable().optional(),
    requiredPermission: z.enum(COMMAND_REQUIRABLE_PERMISSIONS).nullable().optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const options = command.options ?? [];
    const names = new Set<string>();
    let sawOptional = false;
    options.forEach((option, index) => {
      if (names.has(option.name)) {
        ctx.addIssue({ code: 'custom', path: ['options', index, 'name'], message: 'duplicate option name' });
      }
      names.add(option.name);
      if (option.required && sawOptional) {
        ctx.addIssue({ code: 'custom', path: ['options', index], message: 'required options must come before optional ones' });
      }
      if (!option.required) sawOptional = true;
    });
  });

export type CommandInput = z.infer<typeof CommandInputSchema>;

/**
 * `PUT /api/bot/v2/commands` body: the full list (≤ 50), as an array or as
 * `{ commands: [...] }` (exactly that one key). Unwrapped first so a bad
 * option is reported at its own path instead of as a vague union failure.
 */
export const CommandListSchema = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'commands' in value
      ? (value as { commands: unknown }).commands
      : value,
  z
    .array(CommandInputSchema, { invalid_type_error: 'expected an array of commands (or { "commands": [...] })' })
    .max(MAX_COMMANDS_PER_BOT, `a bot can register at most ${MAX_COMMANDS_PER_BOT} commands`)
    .superRefine((commands, ctx) => {
      const seen = new Set<string>();
      commands.forEach((command, index) => {
        if (seen.has(command.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'duplicate command name' });
        seen.add(command.name);
      });
    })
);

/** What gets stored: defaults filled in, nothing else. */
export function normalizeCommandOptions(options: CommandInput['options']): CommandOption[] {
  return (options ?? []).map((option) => ({
    name: option.name,
    description: option.description ?? '',
    type: option.type,
    required: option.required ?? false,
    ...(option.min !== undefined ? { min: option.min } : {}),
    ...(option.max !== undefined ? { max: option.max } : {}),
    ...(option.choices ? { choices: option.choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
  }));
}

/** Stored options back to typed ones; anything malformed is dropped (never trusted). */
export function readCommandOptions(stored: readonly unknown[]): CommandOption[] {
  const out: CommandOption[] = [];
  for (const raw of stored) {
    const parsed = OptionSchema.safeParse(raw);
    if (parsed.success) out.push(...normalizeCommandOptions([parsed.data]));
  }
  return out;
}

/** The command's own channel list AND the manager's restriction. */
export function commandAllowedInChannel(
  command: Pick<BotCommandRow, 'channelIds' | 'adminChannelIds'>,
  channelId: string
): boolean {
  if (command.channelIds && !command.channelIds.includes(channelId)) return false;
  if (command.adminChannelIds && !command.adminChannelIds.includes(channelId)) return false;
  return true;
}

/** How the bot itself sees one of its commands. */
export function toBotCommandJson(row: BotCommandRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    options: readCommandOptions(row.options),
    channelIds: row.channelIds,
    requiredPermission: row.requiredPermission,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The manager's view: the bot's fields plus the manager-owned switches. */
export function toAdminCommandJson(row: BotCommandRow) {
  return { ...toBotCommandJson(row), adminChannelIds: row.adminChannelIds };
}

// ── invocation ──────────────────────────────────────────────────────────

export type OptionValue = string | number | boolean;

export interface OptionValidation {
  ok: true;
  values: Record<string, OptionValue>;
  /** user / channel options still to re-check against the database. */
  users: Array<{ option: string; id: string }>;
  channels: Array<{ option: string; id: string }>;
}

const UUID = z.string().uuid();

/**
 * Check a member's option values against the command's schema. Unknown
 * names, wrong types, out-of-range numbers, unlisted choices and over-long
 * strings are all refused; user / channel ids are returned for the
 * caller's database re-check (member of the server / channel the invoker
 * can see).
 */
export function validateOptionValues(
  options: readonly CommandOption[],
  input: unknown
): OptionValidation | { ok: false; issues: string[] } {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    return { ok: false, issues: ['options must be an object'] };
  }
  const given = (input ?? {}) as Record<string, unknown>;
  const issues: string[] = [];
  const known = new Map(options.map((o) => [o.name, o]));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) issues.push(`${name.slice(0, 40)}: unknown option`);
  }
  const values: Record<string, OptionValue> = {};
  const users: OptionValidation['users'] = [];
  const channels: OptionValidation['channels'] = [];
  for (const option of options) {
    const value = given[option.name];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      if (option.required) issues.push(`${option.name}: required`);
      continue;
    }
    switch (option.type) {
      case 'string': {
        if (typeof value !== 'string') {
          issues.push(`${option.name}: must be a string`);
          break;
        }
        if (value.length > COMMAND_STRING_OPTION_MAX_LENGTH) {
          issues.push(`${option.name}: at most ${COMMAND_STRING_OPTION_MAX_LENGTH} characters`);
          break;
        }
        if (option.choices && !option.choices.some((c) => c.value === value)) {
          issues.push(`${option.name}: not one of the choices`);
          break;
        }
        values[option.name] = value;
        break;
      }
      case 'integer':
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value) || (option.type === 'integer' && !Number.isInteger(value))) {
          issues.push(`${option.name}: must be ${option.type === 'integer' ? 'an integer' : 'a number'}`);
          break;
        }
        if (option.min !== undefined && value < option.min) {
          issues.push(`${option.name}: must be at least ${option.min}`);
          break;
        }
        if (option.max !== undefined && value > option.max) {
          issues.push(`${option.name}: must be at most ${option.max}`);
          break;
        }
        if (option.choices && !option.choices.some((c) => c.value === value)) {
          issues.push(`${option.name}: not one of the choices`);
          break;
        }
        values[option.name] = value;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          issues.push(`${option.name}: must be true or false`);
          break;
        }
        values[option.name] = value;
        break;
      }
      case 'user':
      case 'channel': {
        if (!UUID.safeParse(value).success) {
          issues.push(`${option.name}: must be a ${option.type} id`);
          break;
        }
        values[option.name] = (value as string).toLowerCase();
        (option.type === 'user' ? users : channels).push({ option: option.name, id: (value as string).toLowerCase() });
        break;
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, values, users, channels };
}

/** The text a member typed into string options — what the Moderation Bot reads. */
export function freeTextOf(options: readonly CommandOption[], values: Record<string, OptionValue>): string {
  return options
    .filter((o) => o.type === 'string' && !o.choices && typeof values[o.name] === 'string')
    .map((o) => values[o.name] as string)
    .join('\n');
}
