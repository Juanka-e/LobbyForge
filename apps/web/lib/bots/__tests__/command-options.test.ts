import { describe, expect, it } from 'vitest';
import {
  checkOptionValues,
  commandsInDisplayOrder,
  filterCommands,
  parseChannelCommand,
  type ChannelCommand,
  type CommandOption,
} from '../command-options';

const dice = { id: 'b-dice', name: 'Dice', online: true };
const poll = { id: 'b-poll', name: 'Pollster', online: true };

function command(id: string, name: string, bot = dice): ChannelCommand {
  return { id, name, description: '', options: [], bot };
}

describe('parseChannelCommand', () => {
  it('keeps what the composer needs and drops malformed options', () => {
    const parsed = parseChannelCommand({
      id: 'c1',
      name: 'roll',
      description: 'Roll dice',
      bot: { id: 'b1', name: 'Dice' },
      options: [
        { name: 'sides', type: 'integer', required: true, min: 2, max: 1000 },
        { name: 'mode', type: 'string', choices: [{ name: 'Public', value: 'public' }, { bogus: true }] },
        { name: 'nope', type: 'date' },
        'garbage',
      ],
    });
    expect(parsed).toEqual({
      id: 'c1',
      name: 'roll',
      description: 'Roll dice',
      bot: { id: 'b1', name: 'Dice', online: true },
      options: [
        { name: 'sides', description: '', type: 'integer', required: true, min: 2, max: 1000 },
        { name: 'mode', description: '', type: 'string', required: false, choices: [{ name: 'Public', value: 'public' }] },
      ],
    });
  });

  it('keeps a bot the server reports offline; a server that does not say means online', () => {
    expect(parseChannelCommand({ id: 'c1', name: 'roll', bot: { id: 'b1', name: 'Dice', online: false } })?.bot.online).toBe(false);
    expect(parseChannelCommand({ id: 'c1', name: 'roll', bot: { id: 'b1', name: 'Dice' } })?.bot.online).toBe(true);
  });

  it('refuses a command without an id or a bot', () => {
    expect(parseChannelCommand({ name: 'roll', bot: dice })).toBeNull();
    expect(parseChannelCommand({ id: 'c1', name: 'roll' })).toBeNull();
  });
});

describe('filterCommands / commandsInDisplayOrder', () => {
  const all = [command('1', 'roll'), command('2', 'poll', poll), command('3', 'reroll'), command('4', 'rps')];

  it('ranks names that start with the query before names that contain it', () => {
    expect(filterCommands(all, 'ro').map((c) => c.name)).toEqual(['roll', 'reroll']);
    expect(filterCommands(all, 'ROLL').map((c) => c.name)).toEqual(['roll', 'reroll']);
    expect(filterCommands(all, '')).toHaveLength(4);
    expect(filterCommands(all, 'xyz')).toEqual([]);
  });

  it('walks the commands bot by bot, as the picker shows them', () => {
    expect(commandsInDisplayOrder(all).map((c) => c.name)).toEqual(['roll', 'reroll', 'rps', 'poll']);
  });

  it('puts an offline bot after the online ones', () => {
    const asleep = { ...dice, online: false };
    const mixed = [command('1', 'roll', asleep), command('2', 'poll', poll), command('3', 'rps', asleep)];
    expect(commandsInDisplayOrder(mixed).map((c) => c.name)).toEqual(['poll', 'roll', 'rps']);
  });
});

describe('checkOptionValues', () => {
  const options: CommandOption[] = [
    { name: 'sides', description: '', type: 'integer', required: true, min: 2, max: 100 },
    { name: 'ratio', description: '', type: 'number', required: false, max: 1 },
    { name: 'mode', description: '', type: 'string', required: false, choices: [{ name: 'Public', value: 'public' }] },
    { name: 'note', description: '', type: 'string', required: false },
    { name: 'loud', description: '', type: 'boolean', required: true },
    { name: 'who', description: '', type: 'user', required: false },
  ];

  it('explains every missing required option', () => {
    const { errors, values } = checkOptionValues(options, {});
    expect(errors).toEqual({ sides: { code: 'required' }, loud: { code: 'required' } });
    expect(values).toEqual({});
  });

  it('checks whole numbers, ranges and choices', () => {
    expect(checkOptionValues(options, { sides: '2.5', loud: false }).errors).toEqual({ sides: { code: 'integer' } });
    expect(checkOptionValues(options, { sides: '1', loud: false }).errors).toEqual({ sides: { code: 'min', min: 2 } });
    expect(checkOptionValues(options, { sides: '101', loud: false }).errors).toEqual({ sides: { code: 'max', max: 100 } });
    expect(checkOptionValues(options, { sides: '6', ratio: 'abc', loud: false }).errors).toEqual({ ratio: { code: 'number' } });
    expect(checkOptionValues(options, { sides: '6', ratio: '1.5', loud: false }).errors).toEqual({ ratio: { code: 'max', max: 1 } });
    expect(checkOptionValues(options, { sides: '6', mode: 'secret', loud: false }).errors).toEqual({ mode: { code: 'choice' } });
    expect(checkOptionValues(options, { sides: '6', note: 'x'.repeat(1001), loud: false }).errors).toEqual({
      note: { code: 'too_long', max: 1000 },
    });
  });

  it('builds the invoke body, leaving blank optional fields out', () => {
    const { errors, values } = checkOptionValues(options, {
      sides: ' 20 ',
      ratio: '0.5',
      mode: 'public',
      note: '',
      loud: true,
      who: 'u-2',
    });
    expect(errors).toEqual({});
    expect(values).toEqual({ sides: 20, ratio: 0.5, mode: 'public', loud: true, who: 'u-2' });
  });
});
