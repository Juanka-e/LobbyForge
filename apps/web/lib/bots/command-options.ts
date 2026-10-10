/**
 * Slash command shapes as the browser sees them, and the composer's
 * client-side option check (BOT_API_V2 §3.1). Client-safe.
 *
 * The server validates every option again — this check exists so a member
 * sees "Sides must be at least 2" next to the field instead of a round
 * trip, never as a security boundary.
 */
import { COMMAND_STRING_OPTION_MAX_LENGTH } from './catalog';

export const COMMAND_OPTION_TYPES = ['string', 'integer', 'number', 'boolean', 'user', 'channel'] as const;
export type CommandOptionType = (typeof COMMAND_OPTION_TYPES)[number];

/** A `string` option holds at most this many characters (§3.1). */
export const STRING_OPTION_MAX_LENGTH = COMMAND_STRING_OPTION_MAX_LENGTH;

export interface CommandOptionChoice {
  name: string;
  value: string | number;
}

export interface CommandOption {
  name: string;
  description: string;
  type: CommandOptionType;
  required: boolean;
  min?: number;
  max?: number;
  choices?: CommandOptionChoice[];
}

/** A command the member may run in a channel (`GET /api/servers/{id}/commands`). */
export interface ChannelCommand {
  id: string;
  name: string;
  description: string;
  options: CommandOption[];
  /** `online: false` — invoking now would answer `bot_offline`; the picker greys the command out. */
  bot: { id: string; name: string; online: boolean };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One option from an API payload; anything malformed is dropped. */
export function parseCommandOption(value: unknown): CommandOption | null {
  const raw = record(value);
  if (!raw || typeof raw.name !== 'string' || !raw.name) return null;
  const type = (COMMAND_OPTION_TYPES as readonly string[]).includes(raw.type as string)
    ? (raw.type as CommandOptionType)
    : null;
  if (!type) return null;
  const option: CommandOption = {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    type,
    required: raw.required === true,
  };
  const min = finite(raw.min);
  const max = finite(raw.max);
  if (min !== undefined) option.min = min;
  if (max !== undefined) option.max = max;
  if (Array.isArray(raw.choices)) {
    const choices = raw.choices
      .map((choice) => record(choice))
      .filter((choice): choice is Record<string, unknown> => Boolean(choice))
      .filter((choice) => typeof choice.value === 'string' || finite(choice.value) !== undefined)
      .map((choice) => ({
        name: typeof choice.name === 'string' && choice.name ? choice.name : String(choice.value),
        value: choice.value as string | number,
      }));
    if (choices.length > 0) option.choices = choices;
  }
  return option;
}

export function parseChannelCommand(value: unknown): ChannelCommand | null {
  const raw = record(value);
  const bot = record(raw?.bot);
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.name) return null;
  if (!bot || typeof bot.id !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    options: Array.isArray(raw.options)
      ? raw.options.map(parseCommandOption).filter((o): o is CommandOption => Boolean(o))
      : [],
    // A server that does not say is treated as online (the invoke route still answers bot_offline).
    bot: { id: bot.id, name: typeof bot.name === 'string' ? bot.name : '', online: bot.online !== false },
  };
}

/**
 * Commands that match what follows the `/`, best first: names starting
 * with the query, then names containing it; ties keep the bot grouping.
 */
export function filterCommands(commands: ChannelCommand[], query: string): ChannelCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const starts: ChannelCommand[] = [];
  const contains: ChannelCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) starts.push(command);
    else if (name.includes(q)) contains.push(command);
  }
  return [...starts, ...contains];
}

/** Commands grouped by bot, in first-seen order. */
export function groupCommandsByBot(
  commands: ChannelCommand[]
): Array<{ bot: ChannelCommand['bot']; commands: ChannelCommand[] }> {
  const groups = new Map<string, { bot: ChannelCommand['bot']; commands: ChannelCommand[] }>();
  for (const command of commands) {
    const group = groups.get(command.bot.id) ?? { bot: command.bot, commands: [] };
    group.commands.push(command);
    groups.set(command.bot.id, group);
  }
  return [...groups.values()];
}

/** The order the picker shows: grouped by bot, offline bots last. */
export function commandsInDisplayOrder(commands: ChannelCommand[]): ChannelCommand[] {
  const groups = groupCommandsByBot(commands);
  return [...groups.filter((g) => g.bot.online), ...groups.filter((g) => !g.bot.online)].flatMap((group) => group.commands);
}

/** What the form holds per option before it is checked. */
export type RawOptionValue = string | boolean | undefined;

export type OptionError =
  | { code: 'required' }
  | { code: 'integer' }
  | { code: 'number' }
  | { code: 'min'; min: number }
  | { code: 'max'; max: number }
  | { code: 'too_long'; max: number }
  | { code: 'choice' };

export interface OptionCheck {
  values: Record<string, string | number | boolean>;
  errors: Record<string, OptionError>;
}

/**
 * Turn the form's raw values into the invoke body's `options`, or explain
 * per option what is wrong. Blank optional fields are left out.
 */
export function checkOptionValues(options: CommandOption[], raw: Record<string, RawOptionValue>): OptionCheck {
  const values: OptionCheck['values'] = {};
  const errors: OptionCheck['errors'] = {};
  for (const option of options) {
    const input = raw[option.name];
    if (option.type === 'boolean') {
      if (typeof input === 'boolean') values[option.name] = input;
      else if (option.required) errors[option.name] = { code: 'required' };
      continue;
    }
    const value = typeof input === 'string' ? (option.type === 'string' ? input : input.trim()) : '';
    if (!value.trim()) {
      if (option.required) errors[option.name] = { code: 'required' };
      continue;
    }
    if (option.type === 'integer' || option.type === 'number') {
      const isValid = option.type === 'integer' ? /^-?\d+$/.test(value) : /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value);
      const parsed = Number(value);
      if (!isValid || !Number.isFinite(parsed)) {
        errors[option.name] = { code: option.type === 'integer' ? 'integer' : 'number' };
        continue;
      }
      if (option.min !== undefined && parsed < option.min) {
        errors[option.name] = { code: 'min', min: option.min };
        continue;
      }
      if (option.max !== undefined && parsed > option.max) {
        errors[option.name] = { code: 'max', max: option.max };
        continue;
      }
      if (option.choices && !option.choices.some((choice) => Number(choice.value) === parsed)) {
        errors[option.name] = { code: 'choice' };
        continue;
      }
      values[option.name] = parsed;
      continue;
    }
    if (option.type === 'string') {
      if (option.choices) {
        const choice = option.choices.find((c) => String(c.value) === value);
        if (!choice) {
          errors[option.name] = { code: 'choice' };
          continue;
        }
        values[option.name] = choice.value;
        continue;
      }
      if (value.length > STRING_OPTION_MAX_LENGTH) {
        errors[option.name] = { code: 'too_long', max: STRING_OPTION_MAX_LENGTH };
        continue;
      }
      values[option.name] = value;
      continue;
    }
    // user / channel: an id picked from a list.
    values[option.name] = value;
  }
  return { values, errors };
}
