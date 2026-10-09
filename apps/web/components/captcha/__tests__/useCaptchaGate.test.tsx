// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type FormEvent } from 'react';
import { I18nProvider, useT } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CaptchaField } from '../CaptchaField';
import { useCaptchaGate, type CaptchaGateOptions } from '../useCaptchaGate';
import type { CaptchaConfig, CaptchaSurface } from '../types';
import { altchaWidget, bodiesFor, captchaConfig, jsonResponse, solveAltcha } from './captcha-test-utils';

const altcha = vi.hoisted(() => ({ loadAltcha: vi.fn(), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altcha);
const scripts = vi.hoisted(() => ({ loadExternalScript: vi.fn(), readPageNonce: vi.fn(() => undefined) }));
vi.mock('@/components/captcha/load-script', () => scripts);

const PROTECTED = '/api/protected';
const BASE_TIME = new Date('2026-10-04T10:00:00Z').getTime();

function Harness(options: Partial<CaptchaGateOptions> & { surface: CaptchaSurface }) {
  const t = useT();
  const gate = useCaptchaGate(options);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await gate.submit((fields) =>
      fetch(PROTECTED, { method: 'POST', body: JSON.stringify({ name: 'Ada', ...fields }) })
    );
    setMessage(
      result.kind === 'blocked' ? t(result.messageKey) : result.kind === 'network' ? 'network' : `status ${result.response.status}`
    );
  }
  return (
    <form onSubmit={submit} onFocus={gate.engage} className="relative" noValidate>
      <input aria-label="Name" />
      <CaptchaField gate={gate} />
      <button type="submit">Send</button>
      <p data-testid="message">{message}</p>
    </form>
  );
}

const renderHarness = (options: Partial<CaptchaGateOptions> & { surface: CaptchaSurface }) =>
  render(
    <I18nProvider {...providerPropsFor('en')}>
      <Harness {...options} />
    </I18nProvider>
  );

let configs: Partial<Record<CaptchaSurface, CaptchaConfig[]>> = {};
let protectedAnswers: Response[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/auth/captcha?surface=')) {
    const surface = new URL(url, 'http://x').searchParams.get('surface') as CaptchaSurface;
    const queue = configs[surface] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next ? jsonResponse(next) : jsonResponse({ error: 'missing' }, 404);
  }
  if (url === PROTECTED) return protectedAnswers.shift() ?? jsonResponse({ ok: true });
  return jsonResponse({}, 404);
});

const configCalls = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/auth/captcha?')).length;
const message = () => screen.getByTestId('message');
/** Past the 2 s minimum fill time of the formToken. */
const afterMinimumFillTime = () => vi.setSystemTime(BASE_TIME + 3_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME);
  configs = {};
  protectedAnswers = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  altcha.loadAltcha.mockReset().mockResolvedValue(undefined);
  scripts.loadExternalScript.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.turnstile;
});

// Real timers (the 2.5 s fill time, the widget start wait) race the CPU when
// the whole suite runs next to other heavy work; the flows are also pinned
// end to end in e2e/captcha.spec.ts and e2e/email.spec.ts.
describe('useCaptchaGate', { timeout: 20_000, retry: 2 }, () => {
  it('shows and sends nothing for adaptive sign-in until the server asks', async () => {
    renderHarness({ surface: 'login', prefetch: false });
    expect(altchaWidget()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    await waitFor(() => expect(configCalls()).toBe(0));
    expect(bodiesFor(fetchMock, PROTECTED)).toEqual([{ name: 'Ada' }]);
  });

  it('keeps the honeypot out of sight and out of reach, and sends it when filled', async () => {
    renderHarness({ surface: 'login', prefetch: false });
    const trap = screen.getByLabelText('Leave this field empty', { selector: 'input' });
    expect(trap).toHaveAttribute('name', 'website');
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap).toHaveAttribute('autocomplete', 'off');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.change(trap, { target: { value: 'https://spam.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    expect(bodiesFor(fetchMock, PROTECTED)[0]).toEqual({ name: 'Ada', website: 'https://spam.example' });
  });

  it('sends the solved ALTCHA token, its provider and the formToken', async () => {
    configs.register = [captchaConfig()];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    afterMinimumFillTime();
    await solveAltcha('pow-1');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    expect(bodiesFor(fetchMock, PROTECTED)[0]).toEqual({
      name: 'Ada',
      captchaToken: 'pow-1',
      captchaProvider: 'altcha',
      formToken: '1790000000000.register.mac',
    });
  });

  it('holds a too-quick send until the formToken is two seconds old', async () => {
    configs.register = [captchaConfig()];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    await solveAltcha('pow-1');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bodiesFor(fetchMock, PROTECTED)).toHaveLength(0);
    // The hook really sleeps the rest of MIN_FILL_MS (2.5 s) before sending.
    await waitFor(() => expect(message()).toHaveTextContent('status 200'), { timeout: 15_000 });
  });

  it('after captcha_required, shows the challenge and sends again with its token', async () => {
    configs.login = [captchaConfig({ surface: 'login', required: false, mode: 'adaptive' })];
    protectedAnswers = [jsonResponse({ error: 'captcha_required' }, 400), jsonResponse({ ok: true })];
    renderHarness({ surface: 'login', prefetch: false });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    expect(altchaWidget()!.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=login');
    await solveAltcha('pow-login');
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    expect(bodiesFor(fetchMock, PROTECTED)).toEqual([
      { name: 'Ada' },
      { name: 'Ada', captchaToken: 'pow-login', captchaProvider: 'altcha' },
    ]);
  });

  it('after captcha_unavailable, fetches the config again and switches the widget to ALTCHA', async () => {
    window.turnstile = {
      render: vi.fn((_el: HTMLElement, options: { callback?: (token: string) => void }) => {
        setTimeout(() => options.callback?.('cf-token'));
        return 'w1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    configs.register = [
      captchaConfig({ provider: 'turnstile', siteKey: 'cf-site' }),
      captchaConfig({ provider: 'altcha' }),
    ];
    protectedAnswers = [jsonResponse({ error: 'captcha_unavailable' }, 400), jsonResponse({ ok: true })];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(window.turnstile!.render).toHaveBeenCalled());
    afterMinimumFillTime();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    await solveAltcha('pow-fallback');
    // The refetched config brings a new formToken, so its 2 s minimum applies again.
    await waitFor(() => expect(message()).toHaveTextContent('status 200'), { timeout: 15_000 });
    const [first, second] = bodiesFor(fetchMock, PROTECTED);
    expect(first).toMatchObject({ captchaToken: 'cf-token', captchaProvider: 'turnstile' });
    expect(second).toMatchObject({ captchaToken: 'pow-fallback', captchaProvider: 'altcha' });
    // The first config, the refetch after captcha_unavailable, and a fresh
    // formToken once the second send used its one.
    await waitFor(() => expect(configCalls()).toBe(3));
  });

  it('after captcha_invalid, says verification failed and does not retry by itself', async () => {
    configs.register = [captchaConfig()];
    protectedAnswers = [jsonResponse({ error: 'captcha_invalid' }, 400)];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    afterMinimumFillTime();
    await solveAltcha('stale');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('Verification failed, try again.'));
    expect(bodiesFor(fetchMock, PROTECTED)).toHaveLength(1);
  });

  // Real timers race the config refresh's re-render against the second solve
  // when the whole suite saturates the CPU; the flow itself is pinned end to
  // end in e2e/email.spec.ts (g2) and e2e/captcha.spec.ts.
  it('after an answer that used the formToken (success or the route\'s own error), the next send carries a fresh one', { retry: 2 }, async () => {
    configs.register = [
      captchaConfig({ formToken: '1790000000000.register.first' }),
      captchaConfig({ formToken: '1790000000000.register.second' }),
    ];
    // e.g. 409 "email taken", then the person tries another address on the same form.
    protectedAnswers = [jsonResponse({ error: 'email_taken' }, 409), jsonResponse({ ok: true })];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    afterMinimumFillTime();
    await solveAltcha('pow-1');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 409'));
    // A fresh config (and formToken) is fetched right after the answer…
    await waitFor(() => expect(configCalls()).toBe(2));
    vi.setSystemTime(BASE_TIME + 10_000);
    await solveAltcha('pow-2');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    // …and the second send uses it, not the spent one.
    expect(bodiesFor(fetchMock, PROTECTED).map((body) => body.formToken)).toEqual([
      '1790000000000.register.first',
      '1790000000000.register.second',
    ]);
  });

  it('a send without a formToken (adaptive sign-in) fetches no config afterwards', async () => {
    renderHarness({ surface: 'login', prefetch: false });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(configCalls()).toBe(0);
  });

  it('after form_rejected, asks to try again and fetches a fresh formToken', async () => {
    configs.register = [captchaConfig()];
    protectedAnswers = [jsonResponse({ error: 'form_rejected' }, 400)];
    renderHarness({ surface: 'register' });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    afterMinimumFillTime();
    await solveAltcha('pow');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('Something went wrong, try again.'));
    await waitFor(() => expect(configCalls()).toBe(2));
  });

  it('does not hang on a widget that failed to load', async () => {
    altcha.loadAltcha.mockRejectedValue(new Error('offline'));
    configs.register = [captchaConfig()];
    renderHarness({ surface: 'register' });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    afterMinimumFillTime();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('The security check could not load.'));
    expect(bodiesFor(fetchMock, PROTECTED)).toHaveLength(0);
  });

  it('a deferred gate shows its widget only once the form is used', async () => {
    configs.guest = [captchaConfig({ surface: 'guest' })];
    renderHarness({ surface: 'guest', deferred: true });
    await waitFor(() => expect(configCalls()).toBe(1));
    expect(altchaWidget()).toBeNull();
    fireEvent.focus(screen.getByLabelText('Name'));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
  });

  it('with no challenge expected (an existing guest session), awaits no widget — only a config in flight', async () => {
    configs.guest = [captchaConfig({ surface: 'guest' })];
    renderHarness({ surface: 'guest', expectChallenge: false });
    // Sent at once: the config is still on its way, and the send waits for it.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(message()).toHaveTextContent('status 200'), { timeout: 15_000 });
    expect(altchaWidget()).toBeNull();
    expect(bodiesFor(fetchMock, PROTECTED)[0]).toEqual({ name: 'Ada', formToken: '1790000000000.guest.mac' });
  });
});
