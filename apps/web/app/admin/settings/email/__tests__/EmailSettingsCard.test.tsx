// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { offeredMailProviders } from '@/lib/mail/providers';
import EmailSettingsCard from '../EmailSettingsCard';
import type { AdminMailSettings } from '../mail-settings-model';

// A passing test from an hour ago: Required needs a test less than a day old.
const RECENT_TEST_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

configure({ asyncUtilTimeout: 5_000 });

function settings(overrides: Partial<AdminMailSettings> = {}): AdminMailSettings {
  return {
    provider: 'none',
    region: null,
    host: null,
    port: null,
    security: null,
    username: null,
    passwordSet: false,
    passwordHint: null,
    from: null,
    dailyLimit: null,
    sentToday: 0,
    lastTest: { at: null, result: null },
    verification: {
      mode: 'off',
      scope: { open_register: true, invite_register: false },
      enforcedSince: null,
      existingDeadline: null,
    },
    disposable: { block: false, allow: [], blockExtra: [] },
    locked: { provider: false, host: false, port: false, security: false, username: false, password: false, from: false, verification: false },
    ...overrides,
  };
}

const configured = (overrides: Partial<AdminMailSettings> = {}) =>
  settings({
    provider: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@smtp-brevo.com',
    passwordSet: true,
    passwordHint: '…abcd',
    from: 'LobbyForge <no-reply@example.org>',
    ...overrides,
  });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let current = settings();
let putAnswer: ((body: Record<string, unknown>) => Response) | null = null;
let testAnswer: Response = json({ result: 'ok' });
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === '/api/admin/mail' && (init.method ?? 'GET') === 'GET') return json(current);
  if (url === '/api/admin/mail' && init.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return putAnswer ? putAnswer(body) : json(current);
  }
  if (url === '/api/admin/mail/test') return testAnswer;
  return json({}, 404);
});

const bodiesFor = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && init?.method === method).map(([, init]) => JSON.parse(String(init!.body)));

const PROVIDERS = offeredMailProviders({ production: false, official: false });

async function renderCard(locale = 'en', providers = PROVIDERS) {
  const view = render(
    <I18nProvider {...providerPropsFor(locale)}>
      <EmailSettingsCard providers={providers} />
    </I18nProvider>
  );
  await screen.findByRole('group', { name: locale === 'en' ? 'Provider' : 'Sağlayıcı' });
  return view;
}

beforeEach(() => {
  current = settings();
  putAnswer = null;
  testAnswer = json({ result: 'ok' });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Admin → Settings → Email', () => {
  it('renders the provider picker from the registry, grouped, with the free limits', async () => {
    await renderCard();
    expect(screen.getByRole('radio', { name: /No email/ })).toBeChecked();
    for (const group of ['Professional', 'Free tiers', 'Custom', 'Development']) expect(screen.getByText(group)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Amazon SES/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Brevo.*Free: 300 emails a day/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Resend.*Free: 3,000 emails a month, at most 100 a day/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Mailpit/ })).toBeInTheDocument();
  });

  it('leaves out the development preset where the registry does not offer it (the official hub)', async () => {
    await renderCard('en', offeredMailProviders({ production: true, official: true }));
    expect(screen.queryByRole('radio', { name: /Mailpit/ })).toBeNull();
    expect(screen.queryByText('Development')).toBeNull();
  });

  it('offers Mailpit on a self-hosted production build as the compose service (mailpit:1025)', async () => {
    await renderCard('en', offeredMailProviders({ production: true, official: false }));
    fireEvent.click(screen.getByRole('radio', { name: /Mailpit/ }));
    expect(screen.getByLabelText('SMTP host')).toHaveValue('mailpit');
    expect(screen.getByLabelText('Port')).toHaveValue('1025');
    expect(screen.getByLabelText('Encryption')).toHaveValue('none');
  });

  it('fills localhost:19525 for Mailpit outside production (the dev host)', async () => {
    await renderCard('en', offeredMailProviders({ production: false, official: false }));
    fireEvent.click(screen.getByRole('radio', { name: /Mailpit/ }));
    expect(screen.getByLabelText('SMTP host')).toHaveValue('localhost');
    expect(screen.getByLabelText('Port')).toHaveValue('19525');
  });

  it('choosing a preset fills the connection and shows its hints, notes and KVKK note', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('radio', { name: /Amazon SES/ }));
    expect(screen.getByLabelText('Region')).toHaveValue('eu-central-1');
    expect(screen.getByLabelText('SMTP host')).toHaveValue('email-smtp.eu-central-1.amazonaws.com');
    expect(screen.getByLabelText('SMTP host')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Port')).toHaveValue('587');
    expect(screen.getByLabelText('Encryption')).toHaveValue('starttls');
    expect(screen.getByLabelText('User name')).toHaveAccessibleDescription(/SMTP user name from the SES console/);
    const notes = screen.getByTestId('provider-notes');
    expect(within(notes).getByRole('link', { name: /Amazon SES SMTP setup guide/ })).toHaveAttribute(
      'href',
      'https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html'
    );
    expect(notes).toHaveTextContent('Amazon SES is outside Türkiye');
    expect(notes).toHaveTextContent('Choose an EU region');

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-1' } });
    expect(screen.getByLabelText('SMTP host')).toHaveValue('email-smtp.us-east-1.amazonaws.com');
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '465' } });
    expect(screen.getByLabelText('Encryption')).toHaveValue('tls');
  });

  it('a custom server types its own host, port and encryption, with no KVKK note', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('radio', { name: /Custom SMTP/ }));
    expect(screen.getByLabelText('SMTP host')).not.toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'mail.example.org' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '25x25' } });
    expect(screen.getByLabelText('Port')).toHaveValue('2525');
    expect(screen.getByLabelText('Encryption')).toBeEnabled();
    expect(screen.getByTestId('provider-notes')).not.toHaveTextContent('outside Türkiye');
  });

  it('saves in the §5 shape, with the password write-only', async () => {
    putAnswer = (body) => json(configured({ from: String(body.from) }));
    await renderCard();
    fireEvent.click(screen.getByRole('radio', { name: /Brevo/ }));
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'me@smtp-brevo.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'xsmtpsib-key' } });
    fireEvent.change(screen.getByLabelText('From address'), { target: { value: 'LobbyForge <no-reply@example.org>' } });
    fireEvent.change(screen.getByLabelText('Daily limit'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(await screen.findByText('Email settings saved.')).toBeInTheDocument();
    expect(bodiesFor('PUT', '/api/admin/mail')[0]).toEqual({
      provider: 'brevo',
      region: null,
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'starttls',
      username: 'me@smtp-brevo.com',
      password: 'xsmtpsib-key',
      from: 'LobbyForge <no-reply@example.org>',
      dailyLimit: 250,
      verification: { mode: 'off', scope: { open_register: true, invite_register: false }, existingDeadline: null },
      disposable: { block: false, allow: [], blockExtra: [] },
    });
    // The password never comes back: only its hint.
    expect(screen.getByText('Saved, ends in …abcd')).toBeInTheDocument();
  });

  it('keeps Required closed, and says why, until a test of the saved settings passes', async () => {
    current = configured();
    testAnswer = json({ result: 'ok' });
    await renderCard();
    const required = screen.getByRole('radio', { name: /Required/ });
    expect(required).toBeDisabled();
    expect(screen.getByText(/send a successful test with the saved settings first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('Test email sent. Check the inbox.')).toBeInTheDocument();
    // A test of the saved settings goes out with no overrides — and unlocks Required.
    expect(bodiesFor('POST', '/api/admin/mail/test')[0]).toEqual({});
    await waitFor(() => expect(screen.getByRole('radio', { name: /Required/ })).toBeEnabled());
    expect(screen.getByText(/Last test of the saved settings/)).toBeInTheDocument();
  });

  it('tests unsaved connection changes as overrides and explains a classified failure', async () => {
    current = configured({ lastTest: { at: RECENT_TEST_AT, result: 'ok' } });
    testAnswer = json({ result: 'timeout', detail: 'try_port_2525' });
    await renderCard();
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '465' } });
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'me@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('The connection timed out.')).toBeInTheDocument();
    expect(screen.getByText('Your hosting provider may block this port. Try port 2525.')).toBeInTheDocument();
    expect(bodiesFor('POST', '/api/admin/mail/test')[0]).toMatchObject({ to: 'me@example.org', provider: 'brevo', port: 465, security: 'tls' });
    // An unsaved connection keeps Required closed.
    expect(screen.getByRole('radio', { name: /Required/ })).toBeDisabled();
  });

  it('explains the server refusing Required (409 test_required) and an environment lock', async () => {
    current = configured({ lastTest: { at: RECENT_TEST_AT, result: 'ok' } });
    putAnswer = () => json({ error: 'test_required' }, 409);
    await renderCard();
    fireEvent.click(screen.getByRole('radio', { name: /Required/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(await screen.findByText('Send a successful test email with the saved settings before choosing Required.')).toBeInTheDocument();
    putAnswer = () => json({ error: 'locked_by_env', field: 'from' }, 409);
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(
      await screen.findByText("LOBBYFORGE_MAIL_FROM is set by the server's environment and can't be changed here.")
    ).toBeInTheDocument();
  });

  it('shows environment-locked fields read-only', async () => {
    current = configured({
      locked: { provider: true, host: true, port: true, security: true, username: true, password: true, from: true, verification: true },
    });
    await renderCard();
    expect(screen.getByRole('radio', { name: /Brevo/ })).toBeDisabled();
    expect(screen.getByText('Set by LOBBYFORGE_MAIL_PROVIDER')).toBeInTheDocument();
    expect(screen.getByText('Set by LOBBYFORGE_SMTP_HOST')).toBeInTheDocument();
    expect(screen.getByText('Set by LOBBYFORGE_SMTP_PASSWORD')).toBeInTheDocument();
    expect(screen.getByText('Set by LOBBYFORGE_EMAIL_VERIFICATION')).toBeInTheDocument();
    expect(screen.getByLabelText('From address')).toHaveAttribute('readonly');
    expect(screen.getByText("Set in the server's environment")).toBeInTheDocument();
  });

  it('edits scope, the deadline and the disposable lists', async () => {
    current = configured({ lastTest: { at: RECENT_TEST_AT, result: 'ok' }, verification: { ...settings().verification, mode: 'required', enforcedSince: '2026-10-01T00:00:00.000Z' } });
    await renderCard();
    expect(screen.getByText(/Required since/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Sign-up with an invite/ }));
    fireEvent.change(screen.getByLabelText('Existing accounts must verify by'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Block disposable email addresses/ }));
    fireEvent.change(screen.getByLabelText('Always allow'), { target: { value: 'Example.org\nexample.org' } });
    fireEvent.change(screen.getByLabelText('Also block'), { target: { value: 'not a domain' } });
    expect(screen.getByText("Some lines aren't domain names.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(await screen.findByText('Fix the highlighted fields first.')).toBeInTheDocument();
    expect(bodiesFor('PUT', '/api/admin/mail')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Also block'), { target: { value: 'spam.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    await waitFor(() => expect(bodiesFor('PUT', '/api/admin/mail')).toHaveLength(1));
    const body = bodiesFor('PUT', '/api/admin/mail')[0];
    expect(body.verification.scope).toEqual({ open_register: true, invite_register: true });
    expect(body.verification.existingDeadline).toMatch(/^2026-12-3[01]T/);
    expect(body.disposable).toEqual({ block: true, allow: ['example.org'], blockExtra: ['spam.example'] });
  });

  it('while Required is chosen, email cannot be turned off or its password cleared — and says why', async () => {
    current = configured({
      lastTest: { at: RECENT_TEST_AT, result: 'ok' },
      verification: { ...settings().verification, mode: 'required', enforcedSince: '2026-10-01T00:00:00.000Z' },
    });
    await renderCard();
    expect(screen.getByRole('radio', { name: /No email/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /No email/ })).toHaveAccessibleDescription(
      "Email can't be turned off while verification is Required: new members couldn't verify. Choose Optional or Off first."
    );
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(screen.getByText(/so the password can't be removed/)).toBeInTheDocument();
    // Choosing Optional opens both again.
    fireEvent.click(screen.getByRole('radio', { name: /Optional/ }));
    expect(screen.getByRole('radio', { name: /No email/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
  });

  it('explains the server keeping the transport for Required (409 transport_required)', async () => {
    current = configured({ verification: { ...settings().verification, mode: 'required' } });
    putAnswer = () => json({ error: 'transport_required' }, 409);
    await renderCard();
    fireEvent.change(screen.getByLabelText('Daily limit'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(
      await screen.findByText(
        'Verification is Required, so email has to keep working. Choose Optional or Off before turning email off or removing the password.'
      )
    ).toBeInTheDocument();
  });

  it('a new provider, host or user name needs the password again — on save and for the test', async () => {
    current = configured();
    await renderCard();
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'someone-else@smtp-brevo.com' } });
    const password = screen.getByLabelText('Password');
    expect(password).toBeRequired();
    expect(password).toHaveAccessibleDescription(/the saved password is only reused for the same server/);
    expect(screen.queryByRole('button', { name: 'Keep saved password' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(await screen.findByText('Enter the password again: the saved password is only reused for the same server.')).toBeInTheDocument();
    expect(bodiesFor('PUT', '/api/admin/mail')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(bodiesFor('POST', '/api/admin/mail/test')).toHaveLength(0);
    expect(screen.getAllByText('Enter the password again: the saved password is only reused for the same server.').length).toBeGreaterThan(0);

    fireEvent.change(password, { target: { value: 'new-smtp-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    await waitFor(() => expect(bodiesFor('PUT', '/api/admin/mail')).toHaveLength(1));
    expect(bodiesFor('PUT', '/api/admin/mail')[0]).toMatchObject({ username: 'someone-else@smtp-brevo.com', password: 'new-smtp-key' });
  });

  it('maps the server asking for the password, and a test refused for an environment lock', async () => {
    current = configured();
    putAnswer = () => json({ error: 'password_required' }, 400);
    testAnswer = json({ error: 'locked_by_env', field: 'host' }, 409);
    await renderCard();
    fireEvent.change(screen.getByLabelText('Daily limit'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email settings' }));
    expect(await screen.findByText('Enter the password again: the saved password is only reused for the same server.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(
      await screen.findByText("LOBBYFORGE_SMTP_HOST is set by the server's environment and can't be changed here.")
    ).toBeInTheDocument();
  });

  it('warns that turning Required on again restricts everyone since the first time', async () => {
    current = configured({
      lastTest: { at: RECENT_TEST_AT, result: 'ok' },
      verification: { ...settings().verification, mode: 'optional', enforcedSince: '2026-09-01T12:00:00.000Z' },
    });
    await renderCard();
    expect(screen.queryByText(/Turning it on again restricts everyone/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Required/ }));
    expect(screen.getByText(/Required was on before, since September 1, 2026\. Turning it on again restricts everyone/)).toBeInTheDocument();
  });

  it('explains that invite sign-ups are not asked by default', async () => {
    await renderCard();
    expect(screen.getByRole('checkbox', { name: /Sign-up with an invite/ })).toHaveAccessibleName(
      expect.stringContaining("the invite is already a gate, so these accounts aren't asked to verify and Required doesn't limit them")
    );
  });

  it('speaks Turkish', async () => {
    await renderCard('tr');
    expect(screen.getByRole('radio', { name: /E-posta yok/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Brevo.*Ücretsiz: günde 300 e-posta/ })).toBeInTheDocument();
  });
});
