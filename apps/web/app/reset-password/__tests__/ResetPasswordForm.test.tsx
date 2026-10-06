// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import ResetPasswordForm, { resetErrorKey } from '../ResetPasswordForm';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const TOKEN = 'r'.repeat(43);
const RESET_URL = '/api/auth/password/reset';
const fetchMock = vi.fn();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderForm(token: string | null = TOKEN, official = false, locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <ResetPasswordForm token={token} official={official} />
    </I18nProvider>
  );
}

const sentBody = () => JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === RESET_URL)![1].body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/reset-password', () => {
  it('sets a new password with the link, then leads to sign-in', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }, 200));
    const user = userEvent.setup();
    renderForm();
    const password = screen.getByLabelText('New password');
    // The sign-up's rule and meter.
    expect(password).toHaveAccessibleDescription('At least 12 characters');
    await user.type(password, 'short');
    expect(password).toHaveAccessibleDescription('Too short — at least 12 characters');
    await user.clear(password);
    await user.type(password, 'correct-horse-battery');
    expect(password).toHaveAccessibleDescription('Strong — at least 12 characters');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your password was changed' })).toHaveFocus();
    expect(sentBody()).toEqual({ token: TOKEN, newPassword: 'correct-horse-battery' });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('or with the address and the code from the email', async () => {
    window.sessionStorage.setItem('lf-password-reset-email', 'ada@example.org');
    fetchMock.mockResolvedValue(json({ ok: true }, 200));
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Or enter the code from the email' }));
    // Remembered from /forgot-password.
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.org');
    await user.type(screen.getByLabelText('6-digit code'), '12 34 56');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await screen.findByRole('heading', { level: 1, name: 'Your password was changed' });
    expect(sentBody()).toEqual({ email: 'ada@example.org', code: '123456', newPassword: 'correct-horse-battery' });
    expect(window.sessionStorage.getItem('lf-password-reset-email')).toBeNull();
  });

  it('says so when the other sessions could not be signed out', async () => {
    fetchMock.mockResolvedValue(json({ reset: true, warning: 'sessions_not_revoked' }, 200));
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('status')).toHaveTextContent("your other sessions couldn't be signed out");
  });

  it('a refused code gets one clear message and a way to a new email', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_code' }, 400));
    const user = userEvent.setup();
    renderForm(null);
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work. Check it, or request a new email.");
    expect(screen.getAllByRole('link', { name: 'Ask for a new email' })[0]).toHaveAttribute('href', '/forgot-password');
  });

  it('starts with the code form when there is no link', () => {
    renderForm(null);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask for a new email' })).toHaveAttribute('href', '/forgot-password');
  });

  it('refuses a short password before sending', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('New password'), 'too-short');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains an expired link and offers a new email', async () => {
    fetchMock.mockResolvedValue(json({ error: 'expired' }, 400));
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This link or code has expired.');
    expect(screen.getAllByRole('link', { name: 'Ask for a new email' })[0]).toHaveAttribute('href', '/forgot-password');
  });

  it('maps every refusal', () => {
    expect(resetErrorKey(400, { error: 'invalid_token' })).toBe('emailVerification.reset.error.invalidToken');
    expect(resetErrorKey(400, { error: 'expired' })).toBe('emailVerification.reset.error.expired');
    // By code: one message, whatever the reason.
    expect(resetErrorKey(400, { error: 'invalid_code' }, 'code')).toBe('emailVerification.reset.error.codeFailed');
    expect(resetErrorKey(400, { error: 'expired' }, 'code')).toBe('emailVerification.reset.error.codeFailed');
    expect(resetErrorKey(400, { error: 'weak_password' }, 'code')).toBe('emailVerification.reset.error.password');
    expect(resetErrorKey(400, { error: 'invalid_password' })).toBe('emailVerification.reset.error.password');
    expect(resetErrorKey(429, {})).toBe('emailVerification.error.rateLimited');
    expect(resetErrorKey(503, { error: 'mail_unavailable' })).toBe('emailVerification.forgot.unavailable');
    expect(resetErrorKey(500, { error: 'Some English sentence.' })).toBe('emailVerification.reset.failed');
  });

  it('speaks Turkish', () => {
    renderForm(TOKEN, true, 'tr');
    expect(screen.getByRole('heading', { level: 1, name: 'Yeni bir şifre seç' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ya da e-postadaki kodu gir' })).toBeInTheDocument();
  });
});
