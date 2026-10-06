// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { altchaWidget, bodiesFor, captchaConfig, jsonResponse, solveAltcha } from '@/components/captcha/__tests__/captcha-test-utils';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ForgotPasswordForm, { forgotOutcome } from '../ForgotPasswordForm';

const altchaLoader = vi.hoisted(() => ({ loadAltcha: vi.fn(async () => {}), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altchaLoader);
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CONFIG_URL = '/api/auth/captcha?surface=password_reset';
const FORGOT_URL = '/api/auth/password/forgot';
const fetchMock = vi.fn();

function renderForm(official = false, locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <ForgotPasswordForm official={official} />
    </I18nProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('/forgot-password', () => {
  it('asks the password_reset bot check, sends it along, and answers the same either way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));
    fetchMock.mockImplementation(async (url: string) =>
      url === CONFIG_URL ? jsonResponse(captchaConfig({ surface: 'password_reset' })) : jsonResponse({ sent: true }, 202)
    );
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    expect(altchaWidget()!.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=password_reset');
    await user.type(screen.getByLabelText('Email'), ' ada@example.org ');
    vi.setSystemTime(new Date('2026-10-04T10:00:05Z'));
    await solveAltcha('pow-reset');
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Check your inbox' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('If an account exists for ada@example.org, we sent it an email');
    expect(bodiesFor(fetchMock, FORGOT_URL)[0]).toMatchObject({
      email: 'ada@example.org',
      captchaToken: 'pow-reset',
      captchaProvider: 'altcha',
      formToken: '1790000000000.password_reset.mac',
    });
    // The code form on /reset-password starts with this address.
    expect(window.sessionStorage.getItem('lf-password-reset-email')).toBe('ada@example.org');
    expect(screen.getByRole('link', { name: 'Enter the code' })).toHaveAttribute('href', '/reset-password');
  });

  it('says to ask the administrator when the server has no mail (503 mail_unavailable)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === CONFIG_URL ? jsonResponse({ error: 'nope' }, 500) : jsonResponse({ error: 'mail_unavailable' }, 503)
    );
    const user = userEvent.setup();
    renderForm(true);
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Password reset isn't available on this server; ask your administrator."
    );
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('checks the address before sending anything', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Email'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));
    expect(fetchMock.mock.calls.some(([url]) => url === FORGOT_URL)).toBe(false);
  });

  it('maps every answer', () => {
    expect(forgotOutcome(202, { sent: true })).toEqual({ phase: 'sent' });
    expect(forgotOutcome(503, { error: 'mail_unavailable' })).toEqual({ phase: 'unavailable' });
    expect(forgotOutcome(503, { error: 'mail_quota' })).toEqual({ error: 'emailVerification.error.mailQuota' });
    expect(forgotOutcome(429, {})).toEqual({ error: 'emailVerification.error.rateLimited' });
    expect(forgotOutcome(500, {})).toEqual({ error: 'emailVerification.forgot.failed' });
  });

  it('speaks Turkish', () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    renderForm(false, 'tr');
    expect(screen.getByRole('heading', { level: 1, name: 'Şifreni sıfırla' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sıfırlama e-postası gönder' })).toBeInTheDocument();
  });
});
