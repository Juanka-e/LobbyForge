// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import EmailVerificationBanner from '../EmailVerificationBanner';
import EmailUnverifiedNotice from '../EmailUnverifiedNotice';
import { __resetEmailStatusStoreForTests } from '../email-status-store';
import type { EmailStatus } from '../email-status';

configure({ asyncUtilTimeout: 5_000 });

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const STATUS_URL = '/api/auth/email/status';

function status(overrides: Partial<EmailStatus> = {}): EmailStatus {
  return {
    email: 'ada@example.org',
    verified: false,
    mode: 'optional',
    restricted: false,
    pendingChange: null,
    resendAvailableAt: null,
    mailConfigured: true,
    ...overrides,
  };
}

function json(body: unknown, statusCode = 200) {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { 'content-type': 'application/json' } });
}

let current: EmailStatus = status();
let routes: Record<string, (init: RequestInit) => Response> = {};
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === STATUS_URL) return json(current);
  const route = routes[url];
  return route ? route(init) : json({}, 404);
});

const callsTo = (url: string) => fetchMock.mock.calls.filter(([target]) => target === url);

function renderBanner(ui: ReactNode = <EmailVerificationBanner enabled variant="lobby" />, locale = 'en') {
  return render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);
}

beforeEach(() => {
  __resetEmailStatusStoreForTests();
  current = status();
  routes = {};
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmailVerificationBanner', () => {
  it('shows nothing when the address is verified, verification is off, or there is no address', async () => {
    for (const next of [status({ verified: true }), status({ mode: 'off' }), status({ email: null })]) {
      __resetEmailStatusStoreForTests();
      current = next;
      const view = renderBanner();
      await waitFor(() => expect(callsTo(STATUS_URL).length).toBeGreaterThan(0));
      expect(screen.queryByRole('region')).toBeNull();
      view.unmount();
      fetchMock.mockClear();
    }
  });

  it('makes no request at all when not enabled (signed out, a guest)', async () => {
    renderBanner(<EmailVerificationBanner enabled={false} variant="lobby" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a server-provided status in the first paint, without asking again', () => {
    renderBanner(<EmailVerificationBanner enabled variant="hub" initialStatus={status()} />);
    expect(screen.getByRole('region', { name: 'Verify your email address' })).toBeInTheDocument();
    expect(callsTo(STATUS_URL)).toHaveLength(0);
  });

  it('verifies with the 6-digit code and disappears', async () => {
    routes['/api/auth/email/verify'] = () => {
      current = status({ verified: true });
      return json({ verified: true });
    };
    renderBanner();
    const region = await screen.findByRole('region', { name: 'Verify your email address' });
    expect(region).toHaveTextContent('We sent a 6-digit code to ada@example.org.');
    const input = screen.getByLabelText('6-digit code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    fireEvent.change(input, { target: { value: '123 456' } });
    expect(input).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(JSON.parse(String(callsTo('/api/auth/email/verify')[0]![1]!.body))).toEqual({ code: '123456' });
  });

  it('explains a wrong code in words and keeps the banner', async () => {
    routes['/api/auth/email/verify'] = () => json({ error: 'invalid_code' }, 400);
    renderBanner();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code isn't right. Check the email and try again.");
    expect(screen.getByLabelText('6-digit code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('counts down to the next resend', async () => {
    current = status({ resendAvailableAt: new Date(Date.now() + 42_000).toISOString() });
    renderBanner();
    const waiting = await screen.findByRole('button', { name: /^Resend in 0:4\d$/ });
    expect(waiting).toBeDisabled();
  });

  it('resends, says so, and starts the new cooldown the server gave', async () => {
    routes['/api/auth/email/verify/send'] = () => json({ sent: true, resendAvailableAt: new Date(Date.now() + 60_000).toISOString() }, 202);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Resend code' }));
    expect(await screen.findByText('We sent a new code. Check your inbox.')).toBeInTheDocument();
    expect(callsTo('/api/auth/email/verify/send')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Resend in (0:5\d|1:00)$/})).toBeDisabled());
  });

  it('holds Resend for the retryAfter of a rate limit', async () => {
    routes['/api/auth/email/verify/send'] = () => json({ error: 'rate_limited', retryAfter: 30 }, 429);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Resend code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a little and try again.');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Resend in 0:(2\d|30)$/})).toBeDisabled());
  });

  it('says when the server cannot send mail and leaves out Resend', async () => {
    current = status({ mailConfigured: false });
    renderBanner();
    expect(await screen.findByText(/can't send email right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend code' })).toBeNull();
  });

  it('tells a restricted account what stays locked', async () => {
    current = status({ mode: 'required', restricted: true });
    renderBanner();
    const region = await screen.findByRole('region', { name: 'Verify your email to unlock your account' });
    expect(region).toHaveTextContent("you can't send messages or DMs, join voice");
    expect(screen.getByRole('link', { name: 'Change email' })).toHaveAttribute('href', '/settings/my-account#email');
  });

  it('takes the code of a pending email change to the change confirmation', async () => {
    current = status({ pendingChange: 'new@example.org' });
    routes['/api/auth/email/change/confirm'] = () => {
      current = status({ email: 'new@example.org', verified: true });
      return json({ changed: true });
    };
    renderBanner();
    expect(await screen.findByText(/your new address, new@example.org/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(callsTo('/api/auth/email/change/confirm')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('re-checks when the tab comes back, so a link opened elsewhere unlocks it', async () => {
    renderBanner();
    await screen.findByRole('region', { name: 'Verify your email address' });
    current = status({ verified: true });
    await act(async () => {
      // The store skips a re-read within 2 s of the last one.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
      window.dispatchEvent(new Event('focus'));
    });
    vi.restoreAllMocks();
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('a "Verify email" button elsewhere focuses the banner code field instead of opening a dialog', async () => {
    current = status({ mode: 'required', restricted: true });
    renderBanner(
      <>
        <EmailVerificationBanner enabled variant="lobby" />
        <EmailUnverifiedNotice action="message" />
      </>
    );
    const verify = await screen.findByRole('button', { name: 'Verify email' });
    fireEvent.click(verify);
    expect(screen.getByLabelText('6-digit code')).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('speaks Turkish', async () => {
    current = status({ mode: 'required', restricted: true });
    renderBanner(undefined, 'tr');
    expect(await screen.findByRole('region', { name: 'Hesabının kilidini açmak için e-postanı doğrula' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Doğrula' })).toBeInTheDocument();
  });
});

describe('EmailUnverifiedNotice', () => {
  it('opens the verify dialog when no banner is on screen', async () => {
    current = status({ mode: 'required', restricted: true });
    renderBanner(<EmailUnverifiedNotice action="createInvite" />);
    expect(screen.getByText('Verify your email to create invites.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Verify your email address' });
    expect(dialog).toHaveTextContent('We sent a 6-digit code to ada@example.org.');
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
  });
});
