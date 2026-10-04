// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ChannelsClient, { type ChannelView } from '../ChannelsClient';

/**
 * Admin → Channels → Incoming webhooks (BOT_API_V2 §5.1, §7): list,
 * create (the URL is revealed once), rotate, enable/disable, delete with
 * confirmation.
 */

const SERVER = 'srv-1';
const CHANNEL = 'ch-general';
const BASE = `/api/servers/${SERVER}/channels/${CHANNEL}/webhooks`;
const URL_1 = 'https://lobby.example.com/api/webhooks/w-new/tok_SECRET_1';
const URL_2 = 'https://lobby.example.com/api/webhooks/w-ci/tok_SECRET_2';

function channel(overrides: Partial<ChannelView>): ChannelView {
  return {
    id: CHANNEL,
    serverId: SERVER,
    name: 'general',
    type: 'text',
    position: 0,
    pluginId: null,
    topic: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    visibleToRoleIds: [],
    ...overrides,
  };
}

const CI = {
  id: 'w-ci',
  channelId: CHANNEL,
  name: 'CI',
  enabled: true,
  createdBy: { id: 'u1', name: 'Ayşe' },
  createdAt: '2026-09-20T10:00:00.000Z',
  lastUsedAt: null,
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => Response>;

beforeEach(() => {
  calls = [];
  routes = {
    [`GET ${BASE}`]: () => Response.json({ webhooks: [CI] }),
    [`POST ${BASE}`]: (call) =>
      Response.json(
        {
          webhook: { ...CI, id: 'w-new', name: (call.body as { name: string }).name, createdAt: '2026-10-03T10:00:00.000Z' },
          url: URL_1,
        },
        { status: 201 }
      ),
    [`POST ${BASE}/w-ci/token`]: () => Response.json({ webhook: CI, url: URL_2 }),
    [`PATCH ${BASE}/w-ci`]: (call) => Response.json({ webhook: { ...CI, ...(call.body as object) } }),
    [`DELETE ${BASE}/w-ci`]: () => new Response(null, { status: 204 }),
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

function renderPage(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <ChannelsClient
        serverId={SERVER}
        initialChannels={[channel({}), channel({ id: 'v-1', name: 'Lounge', type: 'voice', position: 1 })]}
        roles={[]}
        loadError={null}
      />
    </I18nProvider>
  );
}

async function openWebhooks(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole('button', { name: 'Incoming webhooks for #general' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  return screen.findByTestId('channel-webhooks');
}

describe('incoming webhooks', () => {
  it('are offered for text channels only', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Incoming webhooks for #general' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Incoming webhooks for #Lounge' })).toBeNull();
  });

  it('lists the channel’s webhooks', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await openWebhooks(user);
    const row = await within(section).findByTestId('channel-webhook');
    expect(row).toHaveTextContent('CI');
    expect(row).toHaveTextContent('Enabled');
    expect(row).toHaveTextContent('by Ayşe');
    expect(row).toHaveTextContent('never used');
  });

  it('creates a webhook and shows its URL exactly once', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await openWebhooks(user);
    await within(section).findByTestId('channel-webhook');
    await user.type(within(section).getByLabelText('Webhook name'), 'Deploys');
    await user.click(within(section).getByRole('button', { name: 'Create webhook' }));

    const dialog = await screen.findByRole('dialog', { name: 'URL for Deploys' });
    expect(within(dialog).getByTestId('webhook-url')).toHaveValue(URL_1);
    expect(dialog).toHaveTextContent('This URL will not be shown again.');
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: BASE, method: 'POST', body: { name: 'Deploys' } });

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(within(dialog).getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(URL_1);
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'I saved it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain('tok_SECRET_1');
    expect(within(section).getAllByTestId('channel-webhook').map((r) => r.querySelector('.font-medium')?.textContent)).toEqual([
      'CI',
      'Deploys',
    ]);
  });

  it('rotates the URL only after confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await openWebhooks(user);
    const row = await within(section).findByTestId('channel-webhook');
    await user.click(within(row).getByRole('button', { name: 'New URL' }));
    const confirm = screen.getByRole('dialog', { name: 'Create a new URL for CI?' });
    expect(calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Create new URL' }));
    const reveal = await screen.findByRole('dialog', { name: 'URL for CI' });
    expect(within(reveal).getByTestId('webhook-url')).toHaveValue(URL_2);
  });

  it('disables and deletes with confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await openWebhooks(user);
    const row = await within(section).findByTestId('channel-webhook');
    await user.click(within(row).getByRole('switch', { name: 'Enable CI' }));
    await within(section).findByText('CI is disabled: posts to its URL are refused until you enable it again.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
    expect(row).toHaveTextContent('Disabled');

    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete CI?' });
    expect(confirm).toHaveTextContent('Messages it already posted stay in the channel.');
    await user.click(within(confirm).getByRole('button', { name: 'Delete webhook' }));
    await within(section).findByText('CI was deleted.');
    expect(within(section).queryByTestId('channel-webhook')).toBeNull();
    expect(within(section).getByText('No webhooks in this channel yet.')).toBeInTheDocument();
  });

  it('explains a refusal and is translated', async () => {
    routes[`POST ${BASE}`] = () => Response.json({ error: 'Forbidden' }, { status: 403 });
    const user = userEvent.setup();
    renderPage('tr');
    await user.click(screen.getByRole('button', { name: '#general için gelen webhook\'lar' }));
    const section = await screen.findByTestId('channel-webhooks');
    await within(section).findByTestId('channel-webhook');
    await user.type(within(section).getByLabelText('Webhook adı'), 'X');
    await user.click(within(section).getByRole('button', { name: 'Webhook oluştur' }));
    await waitFor(() =>
      expect(within(section).getByRole('alert')).toHaveTextContent('Webhook\'ları değiştirmek için Kanalları yönet iznine ihtiyacın var.')
    );
  });
});
