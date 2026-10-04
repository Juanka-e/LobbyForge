import { describe, expect, it } from 'vitest';
import {
  CommandInputSchema,
  CommandListSchema,
  commandAllowedInChannel,
  freeTextOf,
  normalizeCommandOptions,
  readCommandOptions,
  validateOptionValues,
  type CommandOption,
} from '../commands';

/** Slash command registration and invocation checks (BOT_API_V2 §3.1, §3.3). */

const roll = {
  name: 'roll',
  description: 'Roll dice',
  options: [
    { name: 'sides', description: 'Sides', type: 'integer', required: true, min: 2, max: 1000 },
    { name: 'who', type: 'user' },
    { name: 'mode', type: 'string', choices: [{ name: 'Public', value: 'public' }] },
  ],
  channelIds: null,
  requiredPermission: null,
};

describe('registration schema', () => {
  it('accepts the contract’s example', () => {
    expect(CommandInputSchema.safeParse(roll).success).toBe(true);
  });

  it('refuses bad names, descriptions and unknown fields', () => {
    for (const name of ['Roll', 'roll dice', '', 'a'.repeat(33), 'émoji', '/roll']) {
      expect(CommandInputSchema.safeParse({ ...roll, name }).success).toBe(false);
    }
    expect(CommandInputSchema.safeParse({ ...roll, description: '' }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, description: 'x'.repeat(101) }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, handler: 'eval' }).success).toBe(false);
  });

  it('refuses more than 25 options, duplicate option names, and required-after-optional', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ name: `o${i}`, type: 'boolean' }));
    expect(CommandInputSchema.safeParse({ ...roll, options: many }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 'a', type: 'string' }, { name: 'a', type: 'integer' }] }).success).toBe(false);
    expect(
      CommandInputSchema.safeParse({ ...roll, options: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string', required: true }] }).success
    ).toBe(false);
  });

  it('keeps min/max to numbers, integer bounds whole, and choices typed and unique', () => {
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 's', type: 'string', min: 1 }] }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 'n', type: 'integer', min: 1.5 }] }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 'n', type: 'number', min: 5, max: 1 }] }).success).toBe(false);
    expect(
      CommandInputSchema.safeParse({ ...roll, options: [{ name: 'n', type: 'integer', choices: [{ name: 'One', value: 'one' }] }] }).success
    ).toBe(false);
    expect(
      CommandInputSchema.safeParse({
        ...roll,
        options: [{ name: 's', type: 'string', choices: [{ name: 'A', value: 'a' }, { name: 'B', value: 'a' }] }],
      }).success
    ).toBe(false);
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` }));
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 's', type: 'string', choices: tooMany }] }).success).toBe(false);
    expect(CommandInputSchema.safeParse({ ...roll, options: [{ name: 'b', type: 'boolean', choices: [{ name: 'Y', value: 'y' }] }] }).success).toBe(false);
  });

  it('requiredPermission must be a core permission id', () => {
    expect(CommandInputSchema.safeParse({ ...roll, requiredPermission: 'kick_members' }).success).toBe(true);
    expect(CommandInputSchema.safeParse({ ...roll, requiredPermission: 'root' }).success).toBe(false);
  });

  it('the list: an array or { commands }, at most 50, names unique — issues point at the bad field', () => {
    expect(CommandListSchema.safeParse([roll]).success).toBe(true);
    expect(CommandListSchema.safeParse({ commands: [roll] }).success).toBe(true);
    expect(CommandListSchema.safeParse({ commands: [roll], extra: true }).success).toBe(false);
    expect(CommandListSchema.safeParse([roll, roll]).success).toBe(false);
    const fifty = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, description: 'd' }));
    expect(CommandListSchema.safeParse(fifty).success).toBe(false);
    const bad = CommandListSchema.safeParse([{ ...roll, options: [{ name: 'Bad', type: 'string' }] }]);
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path).toEqual([0, 'options', 0, 'name']);
  });

  it('stores options with defaults filled in, and never trusts malformed stored ones', () => {
    const parsed = CommandInputSchema.parse(roll);
    const stored = normalizeCommandOptions(parsed.options);
    expect(stored[1]).toEqual({ name: 'who', description: '', type: 'user', required: false });
    expect(readCommandOptions([...stored, { name: 'x', type: 'exec' }, 'junk', null])).toEqual(stored);
  });
});

describe('channel restriction', () => {
  it('needs both the bot’s list and the managers’ list to allow the channel', () => {
    expect(commandAllowedInChannel({ channelIds: null, adminChannelIds: null }, 'c1')).toBe(true);
    expect(commandAllowedInChannel({ channelIds: ['c1'], adminChannelIds: null }, 'c1')).toBe(true);
    expect(commandAllowedInChannel({ channelIds: ['c1'], adminChannelIds: ['c2'] }, 'c1')).toBe(false);
    expect(commandAllowedInChannel({ channelIds: null, adminChannelIds: ['c2'] }, 'c1')).toBe(false);
  });
});

describe('invocation options (server-side, never trust the client)', () => {
  const options: CommandOption[] = normalizeCommandOptions(CommandInputSchema.parse(roll).options);
  const USER = '33333333-3333-4333-8333-333333333333';

  it('accepts valid values and returns the user/channel refs to re-check', () => {
    const result = validateOptionValues(options, { sides: 6, who: USER.toUpperCase(), mode: 'public' });
    expect(result).toEqual({ ok: true, values: { sides: 6, who: USER, mode: 'public' }, users: [{ option: 'who', id: USER }], channels: [] });
  });

  it('refuses unknown names, missing required ones, wrong types, ranges and choices', () => {
    const issues = (input: unknown) => {
      const r = validateOptionValues(options, input);
      return r.ok ? [] : r.issues;
    };
    expect(issues({ sides: 6, sudo: true })).toEqual(['sudo: unknown option']);
    expect(issues({})).toEqual(['sides: required']);
    expect(issues({ sides: '6' })).toEqual(['sides: must be an integer']);
    expect(issues({ sides: 6.5 })).toEqual(['sides: must be an integer']);
    expect(issues({ sides: 1 })).toEqual(['sides: must be at least 2']);
    expect(issues({ sides: 1001 })).toEqual(['sides: must be at most 1000']);
    expect(issues({ sides: Number.NaN })).toEqual(['sides: must be an integer']);
    expect(issues({ sides: 6, mode: 'secret' })).toEqual(['mode: not one of the choices']);
    expect(issues({ sides: 6, who: 'not-a-uuid' })).toEqual(['who: must be a user id']);
    expect(issues([1, 2])).toEqual(['options must be an object']);
    expect(issues(null)).toEqual(['options must be an object']);
  });

  it('caps free strings at 1000 characters and hands them to moderation', () => {
    const textOptions = normalizeCommandOptions([{ name: 'text', type: 'string', required: true }]);
    expect(validateOptionValues(textOptions, { text: 'x'.repeat(1001) }).ok).toBe(false);
    const ok = validateOptionValues(textOptions, { text: 'hello' });
    expect(ok.ok && freeTextOf(textOptions, ok.values)).toBe('hello');
    // Choice values were picked from the bot's list — nothing a member typed.
    const picked = validateOptionValues(options, { sides: 6, mode: 'public' });
    expect(picked.ok && freeTextOf(options, picked.values)).toBe('');
  });
});
