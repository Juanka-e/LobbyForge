// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import VerifyEmailConfirm, { phaseFor } from '../VerifyEmailConfirm';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const TOKEN = 'T'.repeat(43);
const fetchMock = vi.fn();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(props: Partial<Parameters<typeof VerifyEmailConfirm>[0]> = {}, locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <VerifyEmailConfirm token={TOKEN} official={false} continueHref="/lobby" signedIn {...props} />
    </I18nProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/verify-email', () => {
  it('opening the link verifies nothing: it only shows the button', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Confirm your email address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify my email' })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the button POSTs the token and says it worked', async () => {
    fetchMock.mockResolvedValue(json({ verified: true }, 200));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Your email is verified' }, { timeout: 5_000 });
    // Focus moves to the result so it is read out (in an effect after the
    // render, so wait for it under a loaded run).
    await waitFor(() => expect(heading).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/email/verify',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) })
    );
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/lobby');
  });

  it('explains an expired link', async () => {
    fetchMock.mockResolvedValue(json({ error: 'expired' }, 400));
    renderPage({ signedIn: false, continueHref: '/login' });
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'This link has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: 'Verify my email' })).toBeNull();
  });

  it('explains a link that is not valid (or was used)', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_token' }, 400));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    expect(await screen.findByRole('heading', { level: 1, name: "This link isn't valid" })).toBeInTheDocument();
  });

  it('a broken link gets no button at all', () => {
    renderPage({ token: null });
    expect(screen.getByRole('heading', { level: 1, name: "This link isn't valid" })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the button after a rate limit or a network failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'rate_limited' }, 429)).mockRejectedValueOnce(new Error('offline'));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts.');
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Your email couldn't be verified."));
  });

  it('the link of an email-change email confirms the new address', async () => {
    fetchMock.mockResolvedValue(json({ verified: true, changed: true }, 200));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your new email address is confirmed' })).toBeInTheDocument();
  });

  it('says so when another account took the new address meanwhile', async () => {
    fetchMock.mockResolvedValue(json({ error: 'email_taken' }, 409));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Verify my email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is already used by another account.');
  });

  it('maps every answer to a phase', () => {
    expect(phaseFor(200, { verified: true, changed: true })).toBe('changed');
    expect(phaseFor(400, { error: 'invalid_request' })).toBe('invalid');
    expect(phaseFor(200, { verified: true })).toBe('verified');
    expect(phaseFor(409, { error: 'already_verified' })).toBe('verified');
    expect(phaseFor(400, { error: 'expired' })).toBe('expired');
    expect(phaseFor(400, { error: 'invalid_token' })).toBe('invalid');
    expect(phaseFor(429, {})).toBe('rateLimited');
    expect(phaseFor(500, null)).toBe('failed');
  });

  it('speaks Turkish', () => {
    renderPage({}, 'tr');
    expect(screen.getByRole('button', { name: 'E-postamı doğrula' })).toBeInTheDocument();
  });
});
