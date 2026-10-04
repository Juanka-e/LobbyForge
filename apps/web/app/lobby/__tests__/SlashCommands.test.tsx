// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { invalidateChannelCommands } from '@/lib/bots/client-api';
import { interactionStore } from '@/lib/bots/interaction-store';
import { LobbyComposer } from '../LobbyComposer';

/**
 * The composer's slash commands (BOT_API_V2 §3.3, §7): `/` opens an
 * accessible picker over the channel's commands, grouped by bot; picking
 * one shows its option fields; running it calls invoke and leaves a
 * pending row for the invoker.
 */

const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const COMMANDS_URL = `/api/servers/${SERVER}/commands?channelId=${CHANNEL}`;
const INVOKE_URL = (commandId: string) => `/api/servers/${SERVER}/channels/${CHANNEL}/commands/${commandId}/invoke`;

const COMMANDS = {
  commands: [
    {
      id: 'c-roll',
      name: 'roll',
      description: 'Roll dice',
      bot: { id: 'b-dice', name: 'Dice' },
      options: [
        { name: 'sides', description: 'How many sides', type: 'integer', required: true, min: 2, max: 100 },
        { name: 'mode', type: 'string', choices: [{ name: 'Public', value: 'public' }, { name: 'Secret', value: 'secret' }] },
        { name: 'loud', type: 'boolean' },
        { name: 'who', type: 'user' },
        { name: 'where', type: 'channel' },
      ],
    },
    { id: 'c-rps', name: 'rps', description: 'Rock paper scissors', bot: { id: 'b-dice', name: 'Dice' }, options: [] },
    {
      id: 'c-poll',
      name: 'poll',
      description: 'Start a poll',
      bot: { id: 'b-poll', name: 'Pollster' },
      options: [{ name: 'question', type: 'string', required: true }],
    },
  ],
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let invokeResponse: () => Response;

beforeEach(() => {
  calls = [];
  invalidateChannelCommands();
  interactionStore.reset();
  invokeResponse = () => Response.json({ interaction: { id: 'int-1', status: 'pending' } }, { status: 202 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (url === COMMANDS_URL) return Response.json(COMMANDS);
      if (url.endsWith('/invoke')) return invokeResponse();
      return Response.json({});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  interactionStore.reset();
});

function renderComposer(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyComposer
        channelName="general"
        serverId={SERVER}
        channelId={CHANNEL}
        live
        members={[
          { userId: 'u-alice', displayName: 'Alice' },
          { userId: 'u-bob', displayName: 'Bob' },
        ]}
        channels={[
          { id: CHANNEL, name: 'general', category: 'text' },
          { id: 'ch-2', name: 'memes', category: 'text' },
          { id: 'v-1', name: 'Lounge', category: 'voice' },
        ]}
      />
    </I18nProvider>
  );
}

const commandCalls = () => calls.filter((c) => c.url === COMMANDS_URL);
const invokeCalls = () => calls.filter((c) => c.url.endsWith('/invoke'));

describe('slash command picker', () => {
  it('opens on "/" with the commands grouped by bot, each group with the BOT badge', async () => {
    const user = userEvent.setup();
    renderComposer();
    const input = screen.getByRole('combobox', { name: 'Message #general' });
    expect(input).toHaveAttribute('aria-expanded', 'false');

    await user.type(input, '/');
    const listbox = await screen.findByRole('listbox', { name: 'Bot commands' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    await within(listbox).findByRole('option', { name: /\/roll/ });

    const dice = within(listbox).getByRole('group', { name: /Dice/ });
    expect(within(dice).getByText('BOT')).toBeInTheDocument();
    expect(within(dice).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '/rollRoll dice',
      '/rpsRock paper scissors',
    ]);
    const pollster = within(listbox).getByRole('group', { name: /Pollster/ });
    expect(within(pollster).getAllByRole('option')).toHaveLength(1);

    // The first option is active; the input points at it.
    const first = within(dice).getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
  });

  it('filters as you type and loads the list once per channel', async () => {
    const user = userEvent.setup();
    renderComposer();
    const input = screen.getByRole('combobox');
    await user.type(input, '/po');
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['/pollStart a poll']));

    await user.clear(input);
    await user.type(input, '/zz');
    expect(await screen.findByText('No command matches /zz.')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '/r');
    await within(screen.getByRole('listbox')).findAllByRole('option');
    expect(commandCalls()).toHaveLength(1);
  });

  it('is driven by the keyboard: arrows move, Enter picks, Escape cancels back to the input', async () => {
    const user = userEvent.setup();
    renderComposer();
    const input = screen.getByRole('combobox');
    await user.type(input, '/');
    const listbox = await screen.findByRole('listbox');
    await within(listbox).findAllByRole('option');

    await user.keyboard('{ArrowDown}');
    const second = within(listbox).getByRole('option', { name: /\/rps/ });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', second.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(within(listbox).getByRole('option', { name: /\/poll/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}');

    await user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: '/rps' });
    expect(within(form).getByText('This command has no options. Run it when you are ready.')).toBeInTheDocument();
    // No options: focus waits on the run button.
    expect(within(form).getByRole('button', { name: 'Run /rps' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('form')).toBeNull();
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(invokeCalls()).toHaveLength(0);
  });

  it('closes the list on Escape and picks with Tab', async () => {
    const user = userEvent.setup();
    renderComposer();
    const input = screen.getByRole('combobox');
    await user.type(input, '/pol');
    await within(await screen.findByRole('listbox')).findAllByRole('option');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('/pol');

    await user.type(input, 'l');
    await within(await screen.findByRole('listbox')).findAllByRole('option');
    await user.keyboard('{Tab}');
    expect(screen.getByRole('form', { name: '/poll' })).toBeInTheDocument();
    expect(screen.getByLabelText(/question/)).toHaveFocus();
  });
});

describe('option fields', () => {
  async function openRoll(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole('combobox'), '/roll');
    await within(await screen.findByRole('listbox')).findByRole('option', { name: /\/roll/ });
    await user.keyboard('{Enter}');
    return screen.getByRole('form', { name: '/roll' });
  }

  it('enforces required options and ranges before calling invoke', async () => {
    const user = userEvent.setup();
    renderComposer();
    const form = await openRoll(user);
    const sides = within(form).getByLabelText(/sides/);
    expect(sides).toHaveFocus();
    expect(sides).toHaveAttribute('aria-required', 'true');
    expect(within(form).getByText('How many sides · 2 to 100')).toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Run /roll' }));
    expect(within(form).getByText('Fill this in to run the command.')).toBeInTheDocument();
    expect(sides).toHaveAttribute('aria-invalid', 'true');
    expect(sides).toHaveFocus();
    expect(invokeCalls()).toHaveLength(0);

    await user.type(sides, '1');
    await user.keyboard('{Enter}');
    expect(within(form).getByText('Must be at least 2.')).toBeInTheDocument();
    await user.clear(sides);
    await user.type(sides, '101{Enter}');
    expect(within(form).getByText('Must be at most 100.')).toBeInTheDocument();
    expect(invokeCalls()).toHaveLength(0);
  });

  it('sends every option type and leaves a pending row for the invoker', async () => {
    const user = userEvent.setup();
    renderComposer();
    const form = await openRoll(user);
    await user.type(within(form).getByLabelText(/sides/), '20');
    await user.selectOptions(within(form).getByLabelText('mode'), 'secret');
    await user.click(within(form).getByRole('switch', { name: 'loud' }));

    // The member picker reuses the mention list.
    const who = within(form).getByRole('combobox', { name: 'who' });
    await user.type(who, 'ali');
    const memberList = within(form).getByRole('listbox');
    expect(within(memberList).getAllByRole('option').map((o) => o.textContent)).toEqual(['AAlice']);
    await user.keyboard('{Enter}');
    expect(who).toHaveValue('Alice');

    const where = within(form).getByLabelText('where');
    expect(within(where).getByRole('group', { name: 'Voice channels' })).toBeInTheDocument();
    await user.selectOptions(where, 'ch-2');

    await user.click(within(form).getByRole('button', { name: 'Run /roll' }));
    await waitFor(() => expect(invokeCalls()).toHaveLength(1));
    expect(invokeCalls()[0]).toEqual({
      url: INVOKE_URL('c-roll'),
      method: 'POST',
      body: { options: { sides: 20, mode: 'secret', loud: true, who: 'u-alice', where: 'ch-2' } },
    });

    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(interactionStore.getSnapshot().interactions).toEqual([
      expect.objectContaining({
        id: 'int-1',
        serverId: SERVER,
        channelId: CHANNEL,
        botId: 'b-dice',
        botName: 'Dice',
        commandName: 'roll',
        status: 'pending',
      }),
    ]);
  });

  it('shows a refusal inline, in the member’s language', async () => {
    invokeResponse = () => Response.json({ error: 'Missing permission', code: 'missing_permission' }, { status: 403 });
    const user = userEvent.setup();
    renderComposer('tr');
    await user.type(screen.getByRole('combobox'), '/poll');
    await within(await screen.findByRole('listbox')).findByRole('option', { name: /\/poll/ });
    await user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: '/poll' });
    await user.type(within(form).getByLabelText(/question/), 'Pizza mı?{Enter}');
    expect(await within(form).findByRole('alert')).toHaveTextContent('Bu komutun gerektirdiği izne sahip değilsin.');
    expect(form).not.toHaveTextContent('Missing permission');
    expect(interactionStore.getSnapshot().interactions).toEqual([]);
  });

  it('puts a server-side option refusal next to that field', async () => {
    invokeResponse = () =>
      Response.json(
        { error: 'Some options are not valid', code: 'invalid_options', issues: ['question: not one the bot accepts'] },
        { status: 400 }
      );
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByRole('combobox'), '/poll');
    await within(await screen.findByRole('listbox')).findByRole('option', { name: /\/poll/ });
    await user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: '/poll' });
    await user.type(within(form).getByLabelText(/question/), 'x{Enter}');
    expect(await within(form).findByText('The bot does not accept this value.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/question/)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('plain messages', () => {
  it('still posts text that starts with "/" when no command matches', async () => {
    const user = userEvent.setup();
    renderComposer();
    const input = screen.getByRole('combobox');
    await user.type(input, '/shrug');
    await screen.findByText('No command matches /shrug.');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages') && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/messages'))?.body).toEqual({ content: '/shrug' });
  });

  it('offers no picker outside a live community', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider {...providerPropsFor('en')}>
        <LobbyComposer channelName="general" serverId={null} channelId={null} live={false} members={[]} />
      </I18nProvider>
    );
    await user.type(screen.getByRole('textbox'), '/roll');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(commandCalls()).toHaveLength(0);
  });
});
