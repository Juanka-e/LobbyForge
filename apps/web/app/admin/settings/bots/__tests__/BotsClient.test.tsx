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
        { error: 'You cannot give a bot permissions you do not have', code: 'ungrantable_permissions', permissions: ['read_members'] },
        { status: 403 }
      );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Announcer'), { target: { value: 'Spy' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Read member info/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await screen.findByText('You cannot give a bot permissions you do not have yourself: Read member info.');
  });

  it('shows the seven "coming soon" permissions disabled, so they cannot be picked', () => {
    renderPage();
    const reserved = ['join_voice', 'publish_audio', 'read_presence', 'moderate_messages', 'manage_game_session', 'manage_music_queue', 'read_audit_log'];
    const form = screen.getByRole('group', { name: 'Permissions' });
    for (const permission of reserved) {
      const label = form.querySelector<HTMLElement>(`[data-permission="${permission}"]`)!;
      expect(label).toHaveAttribute('data-reserved', 'true');
      expect(label).toHaveTextContent('(coming soon)');
      const box = within(label).getByRole('checkbox');
      expect(box).toBeDisabled();
      expect(box).toHaveAccessibleDescription("Bots can't use this yet.");
    }
    expect(form.querySelectorAll('[data-reserved="true"]')).toHaveLength(7);
    // Clicking a disabled box changes nothing.
    fireEvent.click(within(form.querySelector<HTMLElement>('[data-permission="read_audit_log"]')!).getByRole('checkbox'));
    expect(within(form.querySelector<HTMLElement>('[data-permission="read_audit_log"]')!).getByRole('checkbox')).not.toBeChecked();
    // What the Bot API honours stays selectable.
    expect(within(form).getByRole('checkbox', { name: /Use slash commands/ })).toBeEnabled();
  });

  it('lets a reserved permission a bot already has be removed, but not added back', async () => {
    renderPage([bot({ permissions: ['send_messages', 'read_audit_log'] })]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const row = screen.getByTestId('custom-bot');
    const audit = within(row).getByRole('checkbox', { name: /View the audit log/ });
    expect(audit).toBeChecked();
    expect(audit).toBeEnabled();
    fireEvent.click(audit);
    await waitFor(() => expect(within(row).getByRole('checkbox', { name: /View the audit log/ })).not.toBeChecked());
    expect(within(row).getByRole('checkbox', { name: /View the audit log/ })).toBeDisabled();
  });

  it('says why a greeting with @everyone is refused, before sending it', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Hey @everyone, {user} is here!' } });
    fireEvent.click(within(screen.getByTestId('welcome-bot-card')).getByRole('button', { name: 'Save' }));
    await screen.findByText("Bot messages can't mention @everyone or @here. Remove it and save again.");
    expect(screen.queryByText('Some of these values are not valid. Check the fields and try again.')).toBeNull();
    expect(calls).toHaveLength(0);
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
    // The untouched name is not sent: it stays the default.
    expect(calls[0]).toEqual({
      url: `/api/servers/${SERVER}/bots/builtin/welcome`,
      method: 'PUT',
      body: {
        enabled: true,
        settings: { channelId: '22222222-2222-4222-8222-222222222222', template: 'Hi {user}!' },
      },
    });
    await screen.findByText('Saved.');
  });

  describe('defaults are never saved as the admin’s own text', () => {
    const welcomeResponse = (call: Call) =>
      Response.json({
        bot: bot({ id: 'w1', type: 'welcome', builtIn: true, name: 'Welcome Bot', defaultName: true, trustLevel: 'official', tokenConfigured: false, settings: { channelId: null, template: null } }),
        created: true,
        sent: call.body,
      });

    it('switching the Welcome Bot on sends no name and no greeting — in any admin language', async () => {
      respond = welcomeResponse;
      renderPage([], 'tr');
      // Pre-filled with the defaults in the admin's language…
      expect(within(screen.getByTestId('welcome-bot-card')).getByLabelText('Ad')).toHaveValue('Karşılama Botu');
      expect(screen.getByLabelText('Karşılama mesajı')).toHaveValue('{user}, {server} sunucusuna hoş geldin! Seni aramızda görmek güzel.');
      expect(screen.getAllByText('Varsayılan metin: her üye kendi dilinde görür.').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('switch', { name: 'Karşılama botunu etkinleştir' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      // …but none of it is sent.
      expect(calls[0]!.body).toEqual({ enabled: true, settings: { channelId: null } });
      expect(JSON.stringify(calls[0]!.body)).not.toContain('Karşılama');
    });

    it('switching the Moderation Bot on sends no name and no notice', async () => {
      respond = () => Response.json({ bot: bot({ id: 'm1', type: 'moderation', builtIn: true, name: 'Moderation Bot', defaultName: true, trustLevel: 'official' }), created: true });
      renderPage();
      fireEvent.click(screen.getByRole('switch', { name: 'Post a notice in the channel' }));
      expect(screen.getByLabelText('Notice')).toHaveValue('A message from {user} was blocked by the moderation filter.');
      fireEvent.click(screen.getByRole('switch', { name: 'Enable the moderation bot' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      const body = calls[0]!.body as { name?: unknown; settings: Record<string, unknown> };
      expect(body).not.toHaveProperty('name');
      expect(body.settings).not.toHaveProperty('noticeTemplate');
      expect(body.settings.postNotice).toBe(true);
    });

    it('sends what the admin edits; cleared or edited back to the default, it sends null', async () => {
      respond = welcomeResponse;
      renderPage();
      fireEvent.change(within(screen.getByTestId('welcome-bot-card')).getByLabelText('Name'), { target: { value: 'Kapıcı' } });
      // Edited, then put back to the default word for word: still the default.
      fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Welcome, {user}!' } });
      fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'Welcome to {server}, {user}! Glad you are here.' } });
      fireEvent.click(within(screen.getByTestId('welcome-bot-card')).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.body).toMatchObject({ name: 'Kapıcı', settings: { template: null } });

      fireEvent.change(within(screen.getByTestId('welcome-bot-card')).getByLabelText('Name'), { target: { value: '   ' } });
      fireEvent.click(within(screen.getByTestId('welcome-bot-card')).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]!.body).toMatchObject({ name: null });
      expect((calls[1]!.body as { settings: Record<string, unknown> }).settings).not.toHaveProperty('template');
    });

    it('an admin’s own greeting can go back to the default', async () => {
      respond = welcomeResponse;
      renderPage([
        bot({ id: 'w1', type: 'welcome', builtIn: true, name: 'Greeter', defaultName: false, trustLevel: 'official', tokenConfigured: false, settings: { channelId: null, template: 'Hi {user}!' } }),
      ]);
      expect(within(screen.getByTestId('welcome-bot-card')).getByLabelText('Name')).toHaveValue('Greeter');
      expect(screen.getByLabelText('Greeting')).toHaveValue('Hi {user}!');
      expect(screen.getAllByText('Your own text: everyone sees it exactly as written.').length).toBeGreaterThan(0);
      const card = screen.getByTestId('welcome-bot-card');
      // The name and the greeting each have their own way back.
      fireEvent.click(within(card).getAllByRole('button', { name: 'Use the default' })[1]!);
      expect(screen.getByLabelText('Greeting')).toHaveValue('Welcome to {server}, {user}! Glad you are here.');
      fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      // The name was not touched, so it is not sent.
      expect(calls[0]!.body).toEqual({ enabled: true, settings: { channelId: null, template: null } });
    });

    it('shows a default-named bot in the admin’s language, whatever language it was stored in', () => {
      renderPage(
        [bot({ id: 'w1', type: 'welcome', builtIn: true, name: 'Welcome Bot', defaultName: true, trustLevel: 'official', tokenConfigured: false, settings: { channelId: null, template: null } })],
        'tr'
      );
      expect(within(screen.getByTestId('welcome-bot-card')).getByLabelText('Ad')).toHaveValue('Karşılama Botu');
      expect(within(screen.getByTestId('welcome-bot-card')).getByRole('heading', { level: 3 })).toHaveTextContent('Karşılama Botu');
    });
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
