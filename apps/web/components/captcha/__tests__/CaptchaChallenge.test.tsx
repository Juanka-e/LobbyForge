// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CaptchaChallenge } from '../CaptchaChallenge';
import type { CaptchaHandle } from '../types';
import { altchaWidget, captchaConfig, jsonResponse, solveAltcha } from './captcha-test-utils';

const altcha = vi.hoisted(() => ({ loadAltcha: vi.fn(), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altcha);

const scripts = vi.hoisted(() => ({ loadExternalScript: vi.fn(), readPageNonce: vi.fn(() => 'page-nonce') }));
vi.mock('@/components/captcha/load-script', () => scripts);

const reload = vi.hoisted(() => vi.fn());
vi.mock('@/components/captcha/ChallengeStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ChallengeStatus')>()),
  reloadPage: reload,
}));

const renderIn = (ui: ReactElement, locale = 'en') => render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);
const fetchMock = vi.fn();

beforeEach(() => {
  altcha.loadAltcha.mockReset().mockResolvedValue(undefined);
  altcha.registerAltchaStrings.mockReset();
  scripts.loadExternalScript.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  document.documentElement.className = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.turnstile;
  delete window.grecaptcha;
});

describe('CaptchaChallenge', { timeout: 20_000 }, () => {
  it('shows a placeholder while its config loads, then the ALTCHA widget for that surface', async () => {
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderIn(<CaptchaChallenge surface="guest" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading the security check…');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/captcha?surface=guest', expect.objectContaining({ cache: 'no-store' }));

    await act(async () => answer(jsonResponse(captchaConfig({ surface: 'guest' }))));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    const widget = altchaWidget()!;
    expect(widget.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=guest');
    expect(widget.getAttribute('auto')).toBe('onload');
    expect(widget.getAttribute('language')).toBe('en');
    // Themed through the app's variables, not ALTCHA's own palette.
    expect(widget.style.getPropertyValue('--altcha-color-base')).toBe('var(--lf-surface)');
    expect(screen.getByRole('group', { name: 'Security check' })).toBeInTheDocument();
  });

  it('gives ALTCHA the catalogue’s words in the page language', async () => {
    renderIn(<CaptchaChallenge surface="register" config={captchaConfig()} />, 'tr');
    await waitFor(() => expect(altcha.registerAltchaStrings).toHaveBeenCalled());
    const [language, strings] = altcha.registerAltchaStrings.mock.calls.at(-1)!;
    expect(language).toBe('tr');
    expect(strings).toMatchObject({ label: 'Robot değilim', verified: 'Doğrulandı', verifying: 'Doğrulanıyor…' });
    expect(altchaWidget()!.getAttribute('language')).toBe('tr');
  });

  it('hands out the ALTCHA token once solved, and its handle executes and resets', async () => {
    const onToken = vi.fn();
    let handle: CaptchaHandle | null = null;
    renderIn(
      <CaptchaChallenge surface="register" config={captchaConfig()} onToken={onToken} onReady={(h) => (handle = h)} />
    );
    await waitFor(() => expect(handle).not.toBeNull());
    expect(handle!.provider).toBe('altcha');
    expect(handle!.surface).toBe('register');

    const pending = handle!.execute();
    await solveAltcha('solved-payload');
    await expect(pending).resolves.toBe('solved-payload');
    expect(onToken).toHaveBeenLastCalledWith('solved-payload');
    // A second call reuses the token it has.
    await expect(handle!.execute()).resolves.toBe('solved-payload');

    act(() => handle!.reset());
    expect(onToken).toHaveBeenLastCalledWith(null);
  });

  it('offers a retry when the ALTCHA module fails to load', async () => {
    altcha.loadAltcha.mockRejectedValueOnce(new Error('chunk failed'));
    const onLoadError = vi.fn();
    renderIn(<CaptchaChallenge surface="register" config={captchaConfig()} onLoadError={onLoadError} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The security check could not load.');
    expect(onLoadError).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    expect(altcha.loadAltcha).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when the provider is off', () => {
    const { container } = renderIn(<CaptchaChallenge surface="register" config={captchaConfig({ provider: 'none' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('when its own config cannot be fetched, says so and fetches again on retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    fetchMock.mockResolvedValueOnce(jsonResponse(captchaConfig({ surface: 'guest' })));
    renderIn(<CaptchaChallenge surface="guest" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('Cloudflare Turnstile', () => {
    function stubTurnstile() {
      const api = {
        render: vi.fn((_el: HTMLElement, _options: Record<string, unknown>) => 'widget-1'),
        reset: vi.fn(),
        remove: vi.fn(),
      };
      window.turnstile = api as unknown as NonNullable<Window['turnstile']>;
      return api;
    }

    it('renders explicitly with the surface as action, the page theme and language, and no form field', async () => {
      const api = stubTurnstile();
      document.documentElement.classList.add('lf-theme-light');
      const onToken = vi.fn();
      renderIn(
        <CaptchaChallenge
          surface="guest"
          config={captchaConfig({ surface: 'guest', provider: 'turnstile', siteKey: 'site-key-1' })}
          onToken={onToken}
        />,
        'tr'
      );
      await waitFor(() => expect(api.render).toHaveBeenCalled());
      expect(scripts.loadExternalScript).toHaveBeenCalledWith('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      const options = api.render.mock.calls[0]![1] as Record<string, unknown>;
      expect(options).toMatchObject({
        sitekey: 'site-key-1',
        action: 'guest',
        theme: 'light',
        language: 'tr',
        appearance: 'interaction-only',
        'response-field': false,
      });
      act(() => (options.callback as (token: string) => void)('cf-token'));
      expect(onToken).toHaveBeenLastCalledWith('cf-token');
    });

    it('shows the load error when the script is blocked, and retries the script and the config', async () => {
      scripts.loadExternalScript.mockRejectedValueOnce(new Error('blocked'));
      const api = stubTurnstile();
      const onReload = vi.fn();
      renderIn(
        <CaptchaChallenge
          surface="register"
          config={captchaConfig({ provider: 'turnstile', siteKey: 'site-key-1', options: { turnstileAppearance: 'always' } })}
          onReload={onReload}
        />
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection or content blocker');
      expect(api.render).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onReload).toHaveBeenCalled();
      await waitFor(() => expect(api.render).toHaveBeenCalled());
      expect(scripts.loadExternalScript).toHaveBeenCalledTimes(2);
    });

    it('when the page’s own CSP blocks Cloudflare (a client-side navigation), offers a reload', async () => {
      stubTurnstile();
      const onLoadError = vi.fn();
      renderIn(
        <CaptchaChallenge
          surface="register"
          config={captchaConfig({ provider: 'turnstile', siteKey: 'site-key-1' })}
          onLoadError={onLoadError}
        />
      );
      await waitFor(() => expect(scripts.loadExternalScript).toHaveBeenCalled());
      act(() => {
        document.dispatchEvent(
          Object.assign(new Event('securitypolicyviolation'), { blockedURI: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x' })
        );
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('This page blocked the security check.');
      expect(onLoadError).toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
      expect(reload).toHaveBeenCalled();
    });

    it('ignores CSP reports about other origins', async () => {
      const api = stubTurnstile();
      renderIn(<CaptchaChallenge surface="register" config={captchaConfig({ provider: 'turnstile', siteKey: 'site-key-1' })} />);
      await waitFor(() => expect(api.render).toHaveBeenCalled());
      act(() => {
        document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { blockedURI: 'https://tracker.example/pixel' }));
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('stops waiting when Cloudflare wants a click, so the form can ask the person', async () => {
      const api = stubTurnstile();
      let handle: CaptchaHandle | null = null;
      renderIn(
        <CaptchaChallenge
          surface="register"
          config={captchaConfig({ provider: 'turnstile', siteKey: 'site-key-1' })}
          onReady={(h) => (handle = h)}
        />
      );
      await waitFor(() => expect(handle).not.toBeNull());
      const options = api.render.mock.calls[0]![1] as Record<string, () => void>;
      const pending = handle!.execute();
      act(() => options['before-interactive-callback']!());
      await expect(pending).resolves.toBeNull();
    });
  });

  describe('Google reCAPTCHA', () => {
    it('v3: loads with the site key and language, executes with the surface as action, and shows Google’s notice', async () => {
      const execute = vi.fn(async () => 'g-token');
      window.grecaptcha = {
        ready: (callback: () => void) => callback(),
        render: vi.fn(),
        reset: vi.fn(),
        execute,
      } as unknown as NonNullable<Window['grecaptcha']>;
      let handle: CaptchaHandle | null = null;
      renderIn(
        <CaptchaChallenge
          surface="invite_register"
          config={captchaConfig({ surface: 'invite_register', provider: 'recaptcha', siteKey: 'g-site' })}
          onReady={(h) => (handle = h)}
        />
      );
      await waitFor(() => expect(handle).not.toBeNull());
      expect(scripts.loadExternalScript).toHaveBeenCalledWith('https://www.google.com/recaptcha/api.js?render=g-site&hl=en');
      await expect(handle!.execute()).resolves.toBe('g-token');
      expect(execute).toHaveBeenCalledWith('g-site', { action: 'invite_register' });
      expect(screen.getByText(/This site is protected by reCAPTCHA/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Privacy Policy/ })).toHaveAttribute('href', 'https://policies.google.com/privacy');
      // The floating badge is hidden in favour of that sentence.
      expect(document.getElementById('lf-recaptcha-badge')?.textContent).toContain('.grecaptcha-badge');
    });

    it('v2 checkbox: renders the box and asks the person instead of waiting when it is not ticked', async () => {
      const renderWidget = vi.fn((_el: HTMLElement, _options: Record<string, unknown>) => 7);
      window.grecaptcha = {
        ready: (callback: () => void) => callback(),
        render: renderWidget,
        reset: vi.fn(),
        execute: vi.fn(),
      } as unknown as NonNullable<Window['grecaptcha']>;
      let handle: CaptchaHandle | null = null;
      renderIn(
        <CaptchaChallenge
          surface="register"
          config={captchaConfig({ provider: 'recaptcha', siteKey: 'g-site', options: { recaptchaVersion: 'v2_checkbox' } })}
          onReady={(h) => (handle = h)}
        />
      );
      await waitFor(() => expect(handle).not.toBeNull());
      expect(scripts.loadExternalScript).toHaveBeenCalledWith('https://www.google.com/recaptcha/api.js?render=explicit&hl=en');
      expect(renderWidget.mock.calls[0]![1]).toMatchObject({ sitekey: 'g-site', theme: 'dark', size: 'normal' });
      await expect(handle!.execute()).resolves.toBeNull();
      const options = renderWidget.mock.calls[0]![1] as Record<string, (token: string) => void>;
      act(() => options.callback!('ticked'));
      await expect(handle!.execute()).resolves.toBe('ticked');
    });
  });
});
