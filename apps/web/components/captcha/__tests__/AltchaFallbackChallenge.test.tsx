// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CaptchaChallenge } from '../CaptchaChallenge';
import { altchaPayload, type AltchaSolution, type AltchaV2Challenge } from '../altcha-fallback-solver';
import type { CaptchaHandle } from '../types';
import { captchaConfig, jsonResponse } from './captcha-test-utils';

/**
 * Plain-HTTP pages (no Web Crypto): the challenge is solved by our pure-JS
 * solver instead of ALTCHA's widget, which cannot run there. The solver's
 * own correctness is tested against altcha-lib in altcha-fallback-solver.test.
 */

const altcha = vi.hoisted(() => ({ loadAltcha: vi.fn(), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altcha);

const runner = vi.hoisted(() => ({ hasWebCrypto: vi.fn(() => false), solveInBackground: vi.fn(), SOLVE_TIMEOUT_MS: 90_000 }));
vi.mock('@/components/captcha/altcha-fallback-runner', () => runner);

const SOLUTION: AltchaSolution = { counter: 42, derivedKey: 'ab'.repeat(32), time: 12.5 };
function challenge(expiresInSeconds = 300): AltchaV2Challenge {
  return {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: '00'.repeat(16),
      salt: '11'.repeat(16),
      cost: 1000,
      keyLength: 32,
      keyPrefix: 'ab'.repeat(16),
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
      data: { surface: 'guest' },
    },
    signature: 'cd'.repeat(32),
  };
}

let served: AltchaV2Challenge = challenge();
const fetchMock = vi.fn(async (url: string) =>
  url === '/api/auth/captcha/challenge?surface=guest' ? jsonResponse(served) : jsonResponse({}, 404)
);

const renderIn = (ui: ReactElement, locale = 'en') => render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);

beforeEach(() => {
  served = challenge();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  runner.hasWebCrypto.mockReturnValue(false);
  runner.solveInBackground.mockReset().mockResolvedValue(SOLUTION);
  altcha.loadAltcha.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ALTCHA without Web Crypto (plain HTTP)', { timeout: 20_000 }, () => {
  it('solves with the JS fallback, shows the same Verified row and hands out the widget’s payload', async () => {
    const onToken = vi.fn();
    let handle: CaptchaHandle | null = null;
    renderIn(
      <CaptchaChallenge
        surface="guest"
        config={captchaConfig({ surface: 'guest' })}
        onToken={onToken}
        onReady={(h) => (handle = h)}
      />
    );
    expect(await screen.findByText('Verifying…')).toBeInTheDocument();
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Verified' })).toHaveAttribute('aria-checked', 'true');
    const expected = altchaPayload(served, SOLUTION);
    expect(onToken).toHaveBeenLastCalledWith(expected);
    await expect(handle!.execute()).resolves.toBe(expected);
    expect(handle!.provider).toBe('altcha');
    // The widget is never loaded where it cannot run.
    expect(altcha.loadAltcha).not.toHaveBeenCalled();
    expect(document.querySelector('altcha-widget')).toBeNull();
    // Solved from the challenge the server sent, as it sent it.
    expect(runner.solveInBackground).toHaveBeenCalledWith(served, expect.anything());
  });

  it('when even that fails, says the instance should use HTTPS — translated — and can try again', async () => {
    runner.solveInBackground.mockRejectedValueOnce(new Error('worker crashed'));
    renderIn(<CaptchaChallenge surface="guest" config={captchaConfig({ surface: 'guest' })} />, 'tr');
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu site HTTPS kullanmadığı için güvenlik kontrolü çalışamadı.');
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(await screen.findByText('Doğrulandı')).toBeInTheDocument();
    expect(runner.solveInBackground).toHaveBeenCalledTimes(2);
  });

  it('a challenge it cannot solve (another algorithm) gets the same HTTPS message', async () => {
    served = { ...challenge(), parameters: { ...challenge().parameters, algorithm: 'ARGON2ID' } };
    renderIn(<CaptchaChallenge surface="guest" config={captchaConfig({ surface: 'guest' })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('this site does not use HTTPS');
    expect(runner.solveInBackground).not.toHaveBeenCalled();
  });

  it('expires with its challenge, and a click solves a new one', async () => {
    served = challenge(-1);
    const onToken = vi.fn();
    renderIn(<CaptchaChallenge surface="guest" config={captchaConfig({ surface: 'guest' })} onToken={onToken} />);
    expect(await screen.findByText('Verification expired. Try again.')).toBeInTheDocument();
    expect(onToken).toHaveBeenLastCalledWith(null);
    served = challenge();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
  });

  it('a spent token is replaced in the background', async () => {
    let handle: CaptchaHandle | null = null;
    renderIn(<CaptchaChallenge surface="guest" config={captchaConfig({ surface: 'guest' })} onReady={(h) => (handle = h)} />);
    await screen.findByText('Verified');
    act(() => handle!.reset());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Verified')).toBeInTheDocument();
  });

  it('keeps the real widget where Web Crypto exists', async () => {
    runner.hasWebCrypto.mockReturnValue(true);
    renderIn(<CaptchaChallenge surface="guest" config={captchaConfig({ surface: 'guest' })} />);
    await waitFor(() => expect(document.querySelector('altcha-widget')).not.toBeNull());
    expect(runner.solveInBackground).not.toHaveBeenCalled();
  });
});
