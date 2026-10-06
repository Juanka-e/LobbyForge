// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { __resetEmailStatusStoreForTests } from '@/components/email-verification/email-status-store';
import type { EmailStatus } from '@/components/email-verification/email-status';
import AccountEmailSection, { changeErrorKey } from '../AccountEmailSection';

configure({ asyncUtilTimeout: 5_000 });

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: vi.fn(), push: vi.fn() }),
}));

function status(overrides: Partial<EmailStatus> = {}): EmailStatus {
  return {
    email: 'ada@example.org',
    verified: true,
    mode: 'optional',
    restricted: false,
    pendingChange: null,
    resendAvailableAt: null,
    mailConfigured: true,
    ...overrides,
  };
}

function json(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
}

let current = status();
let changeAnswer: () => Response = () => json({ pending: true }, 202);
let confirmAnswer: () => Response = () => json({ changed: true });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === '/api/auth/email/status') return json(current);
  if (url === '/api/auth/email/change') return changeAnswer();
  if (url === '/api/auth/email/change/confirm') return confirmAnswer();
  return json({}, 404);
});

function renderSection(locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <AccountEmailSection email="ada@example.org" />
    </I18nProvider>
  );
}

function fillChange(newEmail = 'new@example.org', password = 'hunter2-hunter2') {
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  fireEvent.change(screen.getByLabelText('New email address'), { target: { value: newEmail } });
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: password } });
}

beforeEach(() => {
  __resetEmailStatusStoreForTests();
  current = status();
  changeAnswer = () => json({ pending: true }, 202);
  confirmAnswer = () => json({ changed: true });
  nav.refresh.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings → My account → Email', () => {
  it('shows the address and that it is verified', async () => {
    renderSection();
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('ada@example.org')).toBeInTheDocument();
  });

  it('changes the address through the new inbox: code entry, then confirmed', async () => {
    renderSection();
    await screen.findByText('Verified');
    fillChange();
    expect(screen.getByText(/We'll send a code to the new address/)).toBeInTheDocument();
    current = status({ pendingChange: 'new@example.org' });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('heading', { name: 'Check your new inbox' })).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/auth/email/change')!;
    expect(JSON.parse(String(init!.body))).toEqual({ newEmail: 'new@example.org', currentPassword: 'hunter2-hunter2' });

    // Resend re-sends the same change (the password is still in hand) and holds 60 s.
    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/email/change')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Resend in (0:5\d|1:00)$/ })).toBeDisabled());

    current = status({ email: 'new@example.org' });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Your email address is now new@example.org. Your other devices were signed out.')).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('changes at once when the server sends no email', async () => {
    current = status({ mode: 'off', mailConfigured: false, verified: false });
    changeAnswer = () => json({ changed: true });
    renderSection();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fillChange();
    expect(screen.getByText(/the change happens straight away/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    expect(await screen.findByText('Your email address is now new@example.org.')).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
    // No "Not verified" badge while the instance does not ask for it.
    expect(screen.queryByText('Not verified')).toBeNull();
  });

  it('explains a wrong password and a taken address in words', async () => {
    renderSection();
    await screen.findByText('Verified');
    changeAnswer = () => json({ error: 'invalid_password' }, 400);
    fillChange();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That password isn't right.");
    changeAnswer = () => json({ error: 'email_taken' }, 409);
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That address is already used by another account.'));
  });

  it('a rate-limited change counts down to the next try and keeps the button closed until then', async () => {
    renderSection();
    await screen.findByText('Verified');
    changeAnswer = () => json({ error: 'rate_limited', retryAfter: 42 }, 429);
    fillChange();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/^Too many attempts\. Try again in 0:4\d\.$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('says so once the wait is over', async () => {
    renderSection();
    await screen.findByText('Verified');
    changeAnswer = () => json({ error: 'rate_limited', retryAfter: 1 }, 429);
    fillChange();
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('You can try again now.', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
  });

  it('will not "change" to the same address', async () => {
    renderSection();
    await screen.findByText('Verified');
    fillChange('ADA@example.org');
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That's already your email address.");
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/email/change')).toBe(false);
  });

  it('offers the code entry while the address is not verified', async () => {
    current = status({ verified: false, mode: 'required', restricted: true });
    renderSection();
    expect(await screen.findByText('Not verified')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Verify your email to unlock your account' })).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
  });

  it('maps every change refusal', () => {
    expect(changeErrorKey(400, { error: 'invalid_email' })).toBe('emailVerification.change.error.email');
    expect(changeErrorKey(400, { error: 'disposable_email' })).toBe('emailVerification.change.error.disposable');
    expect(changeErrorKey(429, { error: 'rate_limited' })).toBe('emailVerification.error.rateLimited');
    expect(changeErrorKey(503, { error: 'mail_quota' })).toBe('emailVerification.error.mailQuota');
    expect(changeErrorKey(500, {})).toBe('emailVerification.change.error.generic');
  });
});
