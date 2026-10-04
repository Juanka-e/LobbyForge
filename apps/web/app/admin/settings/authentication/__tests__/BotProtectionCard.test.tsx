// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import BotProtectionCard from '../BotProtectionCard';
import type { AdminCaptchaSettings } from '../bot-protection-model';
import type { PrivacyNoticeSet } from '../PrivacyNoticeDialog';

const NOTICES: PrivacyNoticeSet[] = [
  { code: 'en', name: 'English', altcha: 'EN altcha sentence.', turnstile: 'EN turnstile paragraph.', recaptcha: 'EN recaptcha paragraph.' },
  { code: 'tr', name: 'Türkçe', altcha: 'TR altcha cümlesi.', turnstile: 'TR turnstile paragrafı.', recaptcha: 'TR recaptcha paragrafı.' },
];

function settings(overrides: Partial<AdminCaptchaSettings> = {}): AdminCaptchaSettings {
  return {
    provider: 'altcha',
    surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' },
    siteKey: null,
    secretSet: false,
    secretHint: null,
    options: {
      altchaDifficulty: 'normal',
      turnstileAppearance: 'interaction-only',
      recaptchaVersion: 'v3',
      recaptchaMinScore: 0.5,
      loginFailureThreshold: 3,
    },
    attackMode: { manual: false, autoUntil: null },
    locked: { provider: false, siteKey: false, secretKey: false },
    breaker: { open: false, until: null },
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let current: AdminCaptchaSettings = settings();
let putAnswer: ((body: Record<string, unknown>) => Response) | null = null;
let testAnswer: Response = json({ result: 'ok' });
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === '/api/admin/captcha' && (init.method ?? 'GET') === 'GET') return json(current);
  if (url === '/api/admin/captcha' && init.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return putAnswer ? putAnswer(body) : json(current);
  }
  if (url === '/api/admin/captcha/test') return testAnswer;
  return json({}, 404);
});

const putBodies = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/api/admin/captcha' && init?.method === 'PUT').map(([, init]) => JSON.parse(String(init!.body)));

function renderCard(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <BotProtectionCard notices={NOTICES} />
    </I18nProvider>
  );
}

async function loaded(locale = 'en') {
  const view = renderCard(locale);
  await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0));
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

describe('BotProtectionCard', { timeout: 20_000 }, () => {
  it('loads the settings and marks ALTCHA as the recommended provider', async () => {
    renderCard();
    expect(screen.getByText('Loading bot protection settings…')).toBeInTheDocument();
    const altcha = await screen.findByRole('radio', { name: /ALTCHA \(built in\)/ });
    expect(altcha).toBeChecked();
    expect(within(altcha.closest('label')!).getByText('Recommended')).toBeInTheDocument();
    for (const name of [/^Off/, /Cloudflare Turnstile/, /Google reCAPTCHA/]) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked();
    }
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/captcha', expect.objectContaining({ cache: 'no-store' }));
    // Nothing to save yet.
    expect(screen.getByRole('button', { name: 'Save bot protection' })).toBeDisabled();
  });

  it('says when the settings cannot be loaded, and tries again', async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: 'nope' }, 500));
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Bot protection settings could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /ALTCHA/ })).toBeChecked();
  });

  it('explains the data transfer before an external provider is picked, with a notice per language', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await loaded();
    fireEvent.click(screen.getByRole('radio', { name: /Cloudflare Turnstile/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Before you switch to Cloudflare Turnstile' });
    expect(dialog).toHaveTextContent('sends their IP address');
    expect(within(dialog).getByLabelText('Paragraph for your privacy notice')).toHaveValue('EN turnstile paragraph.');
    expect(within(dialog).getByLabelText('If you stay with ALTCHA, one sentence is enough')).toHaveValue('EN altcha sentence.');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Türkçe' }));
    expect(within(dialog).getByLabelText('Paragraph for your privacy notice')).toHaveValue('TR turnstile paragrafı.');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Copy' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('TR turnstile paragrafı.'));
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // Backing out keeps ALTCHA.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the current provider' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('radio', { name: /ALTCHA/ })).toBeChecked();
  });

  it('saves an external provider with both keys, in the §6.1 shape', async () => {
    putAnswer = (body) => json(settings({ provider: 'turnstile', siteKey: String(body.siteKey), secretSet: true, secretHint: '…cret' }));
    await loaded();
    fireEvent.click(screen.getByRole('radio', { name: /Cloudflare Turnstile/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Cloudflare Turnstile' }));
    expect(screen.getByRole('radio', { name: /Cloudflare Turnstile/ })).toBeChecked();
    expect(screen.getByText(/is a setting of the site key in the Cloudflare dashboard/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Site key'), { target: { value: ' 0x4AAA ' } });
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'top-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    expect(await screen.findByText('Bot protection saved.')).toBeInTheDocument();
    expect(putBodies()).toEqual([
      {
        provider: 'turnstile',
        surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' },
        siteKey: '0x4AAA',
        secretKey: 'top-secret',
        options: current.options,
        attackMode: false,
      },
    ]);
    // The secret never comes back: only its hint.
    expect(screen.getByText('Saved, ends in …cret')).toBeInTheDocument();
  });

  it('will not save an external provider without its keys', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('radio', { name: /Google reCAPTCHA/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Google reCAPTCHA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    expect(await screen.findByText('Enter both the site key and the secret key to use Google reCAPTCHA.')).toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });

  it('keeps, replaces or clears the write-only secret', async () => {
    current = settings({ provider: 'turnstile', siteKey: '0xsite', secretSet: true, secretHint: '…abcd' });
    await loaded();
    expect(screen.getByText('Saved, ends in …abcd')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('The saved secret key will be removed when you save.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByLabelText('Secret key')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Keep saved key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    // Clearing the secret of an active external provider is refused before sending…
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    expect(await screen.findByText(/Enter both the site key and the secret key/)).toBeInTheDocument();
    // …but with ALTCHA chosen, clearing goes out as null.
    fireEvent.click(screen.getByRole('radio', { name: /ALTCHA/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({ provider: 'altcha', siteKey: '0xsite', secretKey: null });
  });

  it('shows environment-locked fields read-only and leaves them out of the save', async () => {
    current = settings({
      provider: 'turnstile',
      siteKey: '0xenv',
      secretSet: true,
      locked: { provider: true, siteKey: true, secretKey: true },
    });
    await loaded();
    expect(screen.getByText('Set by LOBBYFORGE_CAPTCHA_PROVIDER')).toBeInTheDocument();
    expect(screen.getByText('Set by LOBBYFORGE_CAPTCHA_SITE_KEY')).toBeInTheDocument();
    expect(screen.getByText('Set by LOBBYFORGE_CAPTCHA_SECRET_KEY')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ALTCHA/ })).toBeDisabled();
    expect(screen.getByLabelText('Site key')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('checkbox', { name: /Sign-up with an invite/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const body = putBodies()[0];
    expect(body).not.toHaveProperty('siteKey');
    expect(body).not.toHaveProperty('secretKey');
    expect(body.provider).toBe('turnstile');
    expect(body.surfaces.invite_register).toBe('on');
  });

  it('explains a field the environment locked meanwhile (409)', async () => {
    putAnswer = () => json({ error: 'locked_by_env', field: 'siteKey' }, 409);
    await loaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /New guests/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    expect(
      await screen.findByText("LOBBYFORGE_CAPTCHA_SITE_KEY is set by the server's environment and cannot be changed here.")
    ).toBeInTheDocument();
  });

  it('edits the surfaces, the sign-in threshold and attack mode, and shows automatic attack mode', async () => {
    current = settings({ attackMode: { manual: false, autoUntil: new Date(Date.now() + 20 * 60_000).toISOString() } });
    await loaded();
    expect(screen.getByText(/Turned on automatically after many failed sign-ins\. It ends at/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));
    expect(screen.queryByLabelText('Failed sign-ins before asking')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'When suspicious (recommended)' }));
    fireEvent.change(screen.getByLabelText('Failed sign-ins before asking'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Turn on attack mode/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Hard/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save bot protection' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toMatchObject({
      surfaces: { login: 'adaptive' },
      options: { loginFailureThreshold: 10, altchaDifficulty: 'hard' },
      attackMode: true,
    });
  });

  it('turning protection off disables what depends on it', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('radio', { name: /^Off/ }));
    expect(screen.getByText('Protection is off. These settings apply again when you choose a provider.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /New guests/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Turn on attack mode/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test configuration' })).toBeDisabled();
  });

  it('tests the configuration with the unsaved values and reports the result', async () => {
    current = settings({ provider: 'turnstile', siteKey: '0xsite', secretSet: true, secretHint: '…abcd' });
    testAnswer = json({ result: 'bad_secret', detail: 'invalid-input-secret' });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
    expect(await screen.findByText('The provider refused the secret key.')).toBeInTheDocument();
    // An unknown detail code adds nothing — it is never shown raw.
    expect(screen.queryByText('invalid-input-secret')).toBeNull();
    const testCall = fetchMock.mock.calls.find(([url]) => url === '/api/admin/captcha/test')!;
    expect(JSON.parse(String(testCall[1]!.body))).toEqual({ provider: 'turnstile', siteKey: '0xsite', secretKey: 'new-secret' });
  });

  it('explains the known detail codes in the admin’s language', async () => {
    current = settings({ provider: 'recaptcha', siteKey: 'g', secretSet: true });
    const cases: Array<[string, string, string]> = [
      ['unreachable', 'secret_undecryptable', 'The saved secret key can no longer be decrypted'],
      ['missing_keys', 'missing_site_key', 'The site key is missing.'],
      ['missing_keys', 'missing_secret_key', 'The secret key is missing.'],
      ['missing_keys', 'missing_both', 'The site key and the secret key are both missing.'],
      ['ok', 'test_keys', 'public test keys'],
      ['ok', 'recaptcha_reachability_only', 'Only the connection to Google could be checked'],
    ];
    await loaded();
    for (const [result, detail, text] of cases) {
      testAnswer = json({ result, detail });
      fireEvent.click(screen.getByRole('button', { name: 'Test configuration' }));
      expect(await screen.findByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    }
  });

  it('describes invite sign-up as deciding alone only on invite-only instances', async () => {
    await loaded();
    const option = screen.getByRole('checkbox', { name: /Sign-up with an invite/ }).closest('label')!;
    expect(option).toHaveTextContent('only when sign-up is invite-only');
    expect(option).toHaveTextContent('an invite never skips the check');
  });

  it('warns while the external provider is down and ALTCHA stands in', async () => {
    current = settings({
      provider: 'recaptcha',
      siteKey: 'g',
      secretSet: true,
      breaker: { open: true, until: new Date(Date.now() + 4 * 60_000).toISOString() },
    });
    await loaded();
    expect(screen.getByText(/Google reCAPTCHA is not responding\. ALTCHA is used instead until/)).toBeInTheDocument();
  });

  it('reads in Turkish', async () => {
    await loaded('tr');
    expect(screen.getByRole('heading', { name: 'Bot koruması' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ALTCHA \(yerleşik\)/ })).toBeChecked();
    expect(screen.getByText('Önerilen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bot korumasını kaydet' })).toBeDisabled();
  });
});
