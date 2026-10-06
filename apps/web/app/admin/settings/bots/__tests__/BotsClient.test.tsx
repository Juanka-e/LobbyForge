// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import type { BotJson } from '@/lib/bots/admin';
import BotsClient from '../BotsClient';
import { __resetEmailStatusStoreForTests } from '@/components/email-verification/email-status-store';

const SERVER = '11111111-1111-4111-8111-111111111111';
const TOKEN = `lfb_${'a'.repeat(32)}_${'B'.repeat(43)}`;
const NEXT_TOKEN = `lfb_${'a'.repeat(32)}_${'C'.repeat(43)}`;

function bot(overrides: Partial<BotJson> = {}): BotJson {
  return {
    id: 'bot-1',
    serverId: SERVER,
    name: 'Announcer',
    type: 'custom',
    builtIn: false,
    permissions: ['send_messages'],
    enabled: true,
    trustLevel: 'unverified',
    tokenConfigured: true,
    tokenIssuedAt: '2026-09-01T00:00:00.000Z',
    createdBy: { id: 'u1', name: 'Owner' },
    lastUsedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    settings: {},
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => Response;
/** The account's email status (EMAIL.md §4.3) — answered aside, not counted in `calls`. */
let emailStatus: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  respond = () => Response.json({}, { status: 500 });
  emailStatus = { email: 'owner@example.org', verified: true, mode: 'off', restricted: false, pendingChange: null, resendAvailableAt: null, mailConfigured: false };
  __resetEmailStatusStoreForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/email/status') return Response.json(emailStatus);
      const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return respond(call);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(initialBots: BotJson[] = [], locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <BotsClient
        serverId={SERVER}
        serverName="Game Night"
        initialBots={initialBots}
        channels={[{ id: '22222222-2222-4222-8222-222222222222', name: 'general' }]}
        loadError={null}
        canMutate
      />
    </I18nProvider>
  );
}

describe('BotsClient', () => {
  it('locks bot creation for an account that must verify its email first (EMAIL.md §4.2)', async () => {
    emailStatus = { ...emailStatus, verified: false, mode: 'required', restricted: true };
    renderPage();
    expect(await screen.findByText('Verify your email to create bots and bot tokens.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Announcer'), { target: { value: 'Herald' } });
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Verify email' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('explains an email_unverified refusal instead of a raw error', async () => {
    respond = () => Response.json({ error: 'email_unverified' }, { status: 403 });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Announcer'), { target: { value: 'Herald' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByText('Verify your email to create bots and bot tokens.')).toBeInTheDocument();
    expect(screen.queryByText('You need the Manage Community permission to change bots.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeDisabled();
  });


  it('creates a custom bot and shows its token exactly once', async () => {
    respond = (call) =>
      call.method === 'POST' && call.url === `/api/servers/${SERVER}/bots`
        ? Response.json({ bot: bot({ id: 'bot-9', name: 'Herald', permissions: ['read_messages', 'send_messages'] }), token: TOKEN }, { status: 201 })
        : Response.json({}, { status: 500 });
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('Announcer'), { target: { value: 'Herald' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));

    const dialog = await screen.findByRole('dialog', { name: 'Token for Herald' });
    expect(within(dialog).getByTestId('bot-token')).toHaveValue(TOKEN);
    expect(calls[0]).toEqual({
      url: `/api/servers/${SERVER}/bots`,
      method: 'POST',
      body: { name: 'Herald', permissions: ['read_messages', 'send_messages'] },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'I saved it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The token is gone from the page for good; the bot row stays.
    expect(document.body.innerHTML).not.toContain(TOKEN);
    const row = screen.getByTestId('custom-bot');
    expect(row).toHaveTextContent('Herald');
    expect(within(row).getByText('BOT')).toBeInTheDocument();
  });

  it('rotates a token only after confirmation, then reveals the new one', async () => {
    respond = (call) =>
      call.url.endsWith('/token') && call.method === 'POST'
        ? Response.json({ bot: bot(), token: NEXT_TOKEN })
        : Response.json({}, { status: 500 });
    renderPage([bot()]);

    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    const confirm = screen.getByRole('dialog', { name: 'Create a new token for Announcer?' });
    expect(calls).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Create new token' }));

    const reveal = await screen.findByRole('dialog', { name: 'Token for Announcer' });
    expect(within(reveal).getByTestId('bot-token')).toHaveValue(NEXT_TOKEN);
    expect(calls[0]).toMatchObject({ url: `/api/servers/${SERVER}/bots/bot-1/token`, method: 'POST' });
  });

  it('revokes after confirmation', async () => {
    respond = (call) =>
      call.url.endsWith('/token') && call.method === 'DELETE'
        ? Response.json({ bot: bot({ tokenConfigured: false, tokenIssuedAt: null }) })
        : Response.json({}, { status: 500 });
    renderPage([bot()]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    await screen.findByText('The token of Announcer was revoked.');
    expect(screen.getByTestId('custom-bot')).toHaveTextContent('No token');
  });

  it('explains a refused permission in the admin’s words', async () => {
    respond = () =>
      Response.json(
        { error: 'You cannot give a bot permissions you do not have', code: 'ungrantable_permissions', permissions: ['read_audit_log'] },
        { status: 403 }
      );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Announcer'), { target: { value: 'Spy' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /View the audit log/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await screen.findByText('You cannot give a bot permissions you do not have yourself: View the audit log.');
  });

  it('sets up the Welcome Bot with the chosen channel and greeting', async () => {
    respond = (call) =>
      call.method === 'PUT'
        ? Response.json({ bot: bot({ id: 'w1', type: 'welcome', builtIn: true, name: 'Welcome Bot', trustLevel: 'official', tokenConfigured: false, settings: (call.body as { settings: Record<string, unknown> }).settings }), created: true })
        : Response.json({}, { status: 500 });
    renderPage();
    fireEvent.change(screen.getByLabelText('Greeting channel'), { target: { value: '22222222-2222-4222-8222-222222222222' } });
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Hi {user}!' } });
    // The preview fills the placeholders.
    expect(screen.getByText('Hi Alex!')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable the welcome bot' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: `/api/servers/${SERVER}/bots/builtin/welcome`,
      method: 'PUT',
      body: {
        enabled: true,
        name: 'Welcome Bot',
        settings: { channelId: '22222222-2222-4222-8222-222222222222', template: 'Hi {user}!' },
      },
    });
    await screen.findByText('Saved.');
  });

  it('saves the Moderation Bot rules', async () => {
    respond = (call) =>
      call.method === 'PUT'
        ? Response.json({ bot: bot({ id: 'm1', type: 'moderation', builtIn: true, name: 'Moderation Bot', trustLevel: 'official' }), created: true })
        : Response.json({}, { status: 500 });
    renderPage();
    fireEvent.change(screen.getByLabelText('Blocked words'), { target: { value: 'salak*\n\n  kötü söz \n' } });
    fireEvent.change(screen.getByLabelText('Links'), { target: { value: 'allowlist' } });
    fireEvent.change(screen.getByLabelText('Allowed sites'), { target: { value: 'https://www.YouTube.com\nlobbyforge.app' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable the moderation bot' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]!.body as { enabled: boolean; settings: Record<string, unknown> };
    expect(body.enabled).toBe(true);
    expect(body.settings).toMatchObject({
      blockedWords: ['salak*', 'kötü söz'],
      linkPolicy: 'allowlist',
      allowedDomains: ['youtube.com', 'lobbyforge.app'],
      exemptStaff: true,
    });
  });

  it('refuses to send an invalid site list', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Links'), { target: { value: 'allowlist' } });
    fireEvent.change(screen.getByLabelText('Allowed sites'), { target: { value: 'not a site' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable the moderation bot' }));
    await screen.findByText('These are not site addresses: not a site');
    expect(calls).toHaveLength(0);
  });

  it('is fully translated', () => {
    renderPage([bot()], 'tr');
    expect(screen.getByRole('heading', { level: 1, name: 'Botlar' })).toBeInTheDocument();
    expect(screen.getByText('Yerleşik botlar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bot oluştur' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Karşılama botunu etkinleştir' })).toBeInTheDocument();
    expect(screen.getByTestId('custom-bot')).toHaveTextContent('Doğrulanmamış');
  });
});
