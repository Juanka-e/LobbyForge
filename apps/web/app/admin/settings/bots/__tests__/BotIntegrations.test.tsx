// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import type { BotJson } from '@/lib/bots/admin';
import BotsClient from '../BotsClient';

/**
 * Admin → Bots, Bot API v2 (BOT_API_V2 §7): the new permissions with their
 * descriptions, and per custom bot channel access, its commands and its
 * event endpoint.
 */

const SERVER = 'srv-1';
const BOT_ID = 'bot-1';
const BASE = `/api/servers/${SERVER}/bots/${BOT_ID}`;

function bot(overrides: Partial<BotJson> = {}): BotJson {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Dice',
    type: 'custom',
    builtIn: false,
    permissions: ['send_messages', 'slash_commands', 'receive_events'],
    enabled: true,
    trustLevel: 'unverified',
    tokenConfigured: true,
    tokenIssuedAt: '2026-09-01T00:00:00.000Z',
    createdBy: null,
    lastUsedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    settings: {},
    ...overrides,
  };
}

/** The route's shape: every text channel the manager can see, with its state. */
function channels(granted: string[] = []) {
  const all = [
    { id: 'ch-general', name: 'general', gated: false, grantable: true },
    { id: 'ch-memes', name: 'memes', gated: false, grantable: true },
    { id: 'ch-staff', name: 'staff', gated: true, grantable: true },
    { id: 'ch-vault', name: 'vault', gated: true, grantable: false },
  ];
  return all.map((c, position) => ({
    ...c,
    type: 'text',
    position,
    granted: granted.includes(c.id),
    reachable: granted.length > 0 ? granted.includes(c.id) : !c.gated,
  }));
}

function accessBody(channelIds: string[] | null, hiddenGrantCount = 0) {
  return { access: { mode: channelIds ? 'selected' : 'all', channels: channels(channelIds ?? []), hiddenGrantCount } };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => Response>;

beforeEach(() => {
  calls = [];
  routes = {
    [`GET ${BASE}/channel-access`]: () => Response.json(accessBody(null)),
    [`PUT ${BASE}/channel-access`]: (call) => Response.json(accessBody((call.body as { channelIds: string[] | null }).channelIds)),
    [`GET ${BASE}/commands`]: () =>
      Response.json({
        commands: [
          {
            id: 'cmd-roll',
            name: 'roll',
            description: 'Roll dice',
            options: [{ name: 'sides', type: 'integer' }],
            channelIds: null,
            adminChannelIds: null,
            requiredPermission: 'kick_members',
            enabled: true,
          },
        ],
      }),
    [`PATCH ${BASE}/commands/cmd-roll`]: (call) =>
      Response.json({
        command: {
          id: 'cmd-roll',
          name: 'roll',
          description: 'Roll dice',
          options: [{ name: 'sides', type: 'integer' }],
          channelIds: null,
          adminChannelIds: (call.body as { channelIds?: string[] | null }).channelIds ?? null,
          requiredPermission: 'kick_members',
          enabled: (call.body as { enabled?: boolean }).enabled ?? true,
        },
      }),
    [`GET ${BASE}/event-endpoint`]: () =>
      Response.json({
        endpoint: {
          url: 'https://bots.example.com/lobbyforge',
          events: ['interaction_create', 'message_create'],
          enabled: false,
          failureCount: 20,
          disabledReason: 'too_many_failures',
          lastDeliveryAt: '2026-10-02T12:00:00.000Z',
          lastStatus: 503,
        },
      }),
    [`PATCH ${BASE}/event-endpoint`]: () =>
      Response.json({
        endpoint: {
          url: 'https://bots.example.com/lobbyforge',
          events: ['interaction_create', 'message_create'],
          enabled: true,
          failureCount: 0,
          disabledReason: null,
          lastDeliveryAt: '2026-10-02T12:00:00.000Z',
          lastStatus: 503,
        },
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${url}`];
      return route ? route(call) : Response.json({ error: 'nope' }, { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(bots: BotJson[] = [bot()], locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <BotsClient
        serverId={SERVER}
        serverName="Game Night"
        initialBots={bots}
        channels={[{ id: 'ch-general', name: 'general' }]}
        loadError={null}
        canMutate
      />
    </I18nProvider>
  );
}

async function openIntegrations(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole('button', { name: 'Channels, commands and events' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Nothing is loaded until the panel opens.
  expect(calls).toHaveLength(0);
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

describe('permissions', () => {
  it('offers the Bot API v2 permissions with what they allow', () => {
    renderPage([]);
    const slash = screen.getByRole('checkbox', { name: /Use slash commands/ });
    expect(slash).toHaveAccessibleDescription('Register slash commands and answer the members who run them.');
    expect(screen.getByRole('checkbox', { name: /Read member info/ })).toHaveAccessibleDescription(
      "Learn when members join or leave, and look up a member's name and roles."
    );
    expect(screen.getByRole('checkbox', { name: /Receive events/ })).toBeInTheDocument();
  });
});

describe('channel access', () => {
  it('switches from all eligible channels to chosen ones and saves exactly those', async () => {
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-channel-access');
    const all = await within(section).findByRole('radio', { name: /All eligible channels/ });
    expect(all).toBeChecked();
    const save = within(section).getByRole('button', { name: 'Save channel access' });
    expect(save).toBeDisabled();
    expect(within(section).queryByRole('checkbox')).toBeNull();

    await user.click(within(section).getByRole('radio', { name: /Only the channels I choose/ }));
    // An empty selection would leave the bot with no channel at all; the UI
    // (and the API, 1..500 ids) asks for at least one.
    expect(within(section).getByText('Choose at least one channel.')).toBeInTheDocument();
    expect(save).toBeDisabled();

    // A role-gated channel the admin may not grant is shown, explained and locked.
    const vault = within(section).getByRole('checkbox', { name: /#vault/ });
    expect(vault).toBeDisabled();
    expect(vault).toHaveAccessibleDescription(/Only someone who can manage channels can give the bot access to it/);
    const staff = within(section).getByRole('checkbox', { name: /#staff/ });
    expect(staff).toBeEnabled();
    expect(staff).toHaveAccessibleDescription('Restricted to some roles');

    await user.click(within(section).getByRole('checkbox', { name: /#memes/ }));
    await user.click(staff);
    expect(save).toBeEnabled();
    await user.click(save);

    await within(section).findByText('Channel access for Dice was saved.');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: `${BASE}/channel-access`,
      method: 'PUT',
      body: { channelIds: ['ch-memes', 'ch-staff'] },
    });
    expect(save).toBeDisabled();

    // Back to all: the list is not sent.
    await user.click(within(section).getByRole('radio', { name: /All eligible channels/ }));
    await user.click(save);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]!.body).toEqual({ channelIds: null });
  });

  it('lets a manager without Manage Channels keep or drop a private channel the bot already has', async () => {
    routes[`GET ${BASE}/channel-access`] = () => Response.json(accessBody(['ch-general', 'ch-vault'], 2));
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-channel-access');
    expect(await within(section).findByRole('radio', { name: /Only the channels I choose/ })).toBeChecked();
    expect(section).toHaveTextContent('The bot can also reach 2 private channels you cannot see. Saving keeps them.');
    const vault = within(section).getByRole('checkbox', { name: /#vault/ });
    expect(vault).toBeChecked();
    expect(vault).toBeEnabled();
    await user.click(vault);
    await user.click(within(section).getByRole('button', { name: 'Save channel access' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ channelIds: ['ch-general'] }));
  });

  it('drops the "saved" notice as soon as the selection changes (no "saved" next to "choose one")', async () => {
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-channel-access');
    await user.click(await within(section).findByRole('radio', { name: /Only the channels I choose/ }));
    await user.click(within(section).getByRole('checkbox', { name: /#memes/ }));
    await user.click(within(section).getByRole('button', { name: 'Save channel access' }));
    await within(section).findByText('Channel access for Dice was saved.');

    // Un-ticking the only channel: the empty-selection error appears and
    // the stale success notice goes away.
    await user.click(within(section).getByRole('checkbox', { name: /#memes/ }));
    expect(within(section).getByText('Choose at least one channel.')).toBeInTheDocument();
    expect(within(section).queryByText('Channel access for Dice was saved.')).toBeNull();
    expect(within(section).queryByRole('status')).toBeNull();
  });

  it('explains a refused grant in the admin’s words', async () => {
    routes[`PUT ${BASE}/channel-access`] = () =>
      Response.json({ error: 'Granting a private channel needs the Manage Channels permission', code: 'cannot_grant_channel' }, { status: 403 });
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-channel-access');
    await user.click(await within(section).findByRole('radio', { name: /Only the channels I choose/ }));
    await user.click(within(section).getByRole('checkbox', { name: /#general/ }));
    await user.click(within(section).getByRole('button', { name: 'Save channel access' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Giving a bot a private channel needs the Manage Channels permission.'
    );
  });
});

describe('commands', () => {
  it('lists the registered commands and turns one off', async () => {
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-commands');
    const row = await within(section).findByTestId('bot-command');
    expect(row).toHaveTextContent('/roll');
    expect(row).toHaveTextContent('Roll dice');
    expect(row).toHaveTextContent('1 option');
    expect(row).toHaveTextContent('Every channel the bot can reach');
    expect(row).toHaveTextContent('needs Kick members');

    await user.click(within(row).getByRole('switch', { name: 'Enable /roll' }));
    await within(section).findByText('/roll is off: members no longer see it.');
    expect(calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/commands/cmd-roll'))?.body).toEqual({ enabled: false });
    expect(within(row).getByRole('switch', { name: 'Enable /roll' })).toHaveAttribute('aria-checked', 'false');
  });

  it('restricts a command to some of the bot’s channels', async () => {
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const row = await within(await screen.findByTestId('bot-commands')).findByTestId('bot-command');
    await user.click(within(row).getByRole('button', { name: 'Choose channels' }));
    const fieldset = within(row).getByRole('group', { name: 'Where /roll can be used' });
    await user.click(within(fieldset).getByRole('radio', { name: 'Only these channels' }));
    // The bot reaches the ungated channels only (no access rows).
    expect(within(fieldset).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['#general', '#memes']);
    await user.click(within(fieldset).getByRole('checkbox', { name: '#memes' }));
    await user.click(within(fieldset).getByRole('button', { name: 'Save' }));
    await screen.findByText('Channels for /roll were saved.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ channelIds: ['ch-memes'] });
    expect(row).toHaveTextContent('#memes');

    // Editing again makes that notice stale.
    await user.click(within(row).getByRole('button', { name: 'Choose channels' }));
    expect(screen.queryByText('Channels for /roll were saved.')).toBeNull();
  });

  it('says so when the bot has registered nothing', async () => {
    routes[`GET ${BASE}/commands`] = () => Response.json({ commands: [] });
    const user = userEvent.setup();
    renderPage([bot({ permissions: ['send_messages'] })]);
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-commands');
    await within(section).findByText('This bot has not registered any commands yet.');
    expect(section).toHaveTextContent('“Use slash commands” permission');
  });
});

describe('event endpoint', () => {
  it('shows why deliveries stopped and turns them back on', async () => {
    const user = userEvent.setup();
    renderPage();
    await openIntegrations(user);
    const section = await screen.findByTestId('bot-event-endpoint');
    await within(section).findByText('https://bots.example.com/lobbyforge');
    expect(within(section).getByTestId('endpoint-status')).toHaveTextContent('Stopped');
    expect(section).toHaveTextContent('HTTP 503');
    expect(section).toHaveTextContent('20');
    expect(section).toHaveTextContent('Too many failed deliveries in a row.');
    expect(section).toHaveTextContent('interaction_create');

    await user.click(within(section).getByRole('button', { name: 'Re-enable' }));
    await within(section).findByText('Event deliveries are back on.');
    expect(calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/event-endpoint'))?.body).toEqual({ enabled: true });
    expect(within(section).getByTestId('endpoint-status')).toHaveTextContent('Delivering');
    expect(within(section).queryByRole('button', { name: 'Re-enable' })).toBeNull();
  });

  it('has an honest empty state and is translated', async () => {
    routes[`GET ${BASE}/event-endpoint`] = () => Response.json({ endpoint: null });
    const user = userEvent.setup();
    renderPage([bot()], 'tr');
    await user.click(screen.getByRole('button', { name: 'Kanallar, komutlar ve olaylar' }));
    const section = await screen.findByTestId('bot-event-endpoint');
    await within(section).findByText('Olay uç noktası yok. Bot bunu Bot API üzerinden kendisi belirler.');
    expect(screen.getByTestId('bot-channel-access')).toHaveTextContent('Kanal erişimi');
  });
});
