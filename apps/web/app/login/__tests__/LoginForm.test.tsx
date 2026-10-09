// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { altchaWidget, bodiesFor, captchaConfig, jsonResponse, solveAltcha } from '@/components/captcha/__tests__/captcha-test-utils';
import type { CaptchaSurface } from '@/components/captcha/types';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import LoginForm from '../LoginForm';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }) }));
const altchaLoader = vi.hoisted(() => ({ loadAltcha: vi.fn(async () => {}), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altchaLoader);

const BASE_TIME = new Date('2026-10-04T10:00:00Z').getTime();
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/auth/captcha?surface=')) {
    const surface = new URL(url, 'http://x').searchParams.get('surface') as CaptchaSurface;
    return jsonResponse(captchaConfig({ surface, required: surface !== 'login', mode: surface === 'login' ? 'adaptive' : 'on' }));
  }
  if (url === '/api/auth/guest') return jsonResponse({ guest: { gid: 'g', uid: 'u', name: 'Ada' } });
  return jsonResponse({ user: { id: 'u1' } });
});
const configSurfaces = () =>
  fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/auth/captcha?')).map(([url]) => new URL(url, 'http://x').searchParams.get('surface'));

function renderForm(props: Partial<Parameters<typeof LoginForm>[0]> = {}) {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <LoginForm guestEnabled registrationMode="open" initialInviteCode="" {...props} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME);
  fetchMock.mockClear();
  nav.replace.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LoginForm sign-up refusals in words', () => {
  it('a disposable address and an address with an account are explained, not shown as codes', async () => {
    const original = fetchMock.getMockImplementation()!;
    try {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/auth/captcha?surface=')) {
          const surface = new URL(url, 'http://x').searchParams.get('surface') as CaptchaSurface;
          return jsonResponse(captchaConfig({ surface, provider: 'none', required: false, mode: 'off', formToken: null }));
        }
        if (url === '/api/auth/register') return jsonResponse({ error: 'disposable_email' }, 400);
        return jsonResponse({});
      });
      renderForm({ initialMode: 'register' });
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@mailinator.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
      fireEvent.click(screen.getAllByRole('button', { name: 'Create account' }).at(-1)!);
      expect(await screen.findByRole('alert')).toHaveTextContent("Addresses from disposable email services can't be used here.");
      expect(screen.queryByText('disposable_email')).toBeNull();

      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/auth/register' ? jsonResponse({ error: 'An account with this email already exists.' }, 409) : jsonResponse({})
      );
      fireEvent.click(screen.getAllByRole('button', { name: 'Create account' }).at(-1)!);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('An account with this email already exists.'));
    } finally {
      // The module-level mock serves the other suites: put its answers back.
      fetchMock.mockImplementation(original);
    }
  });
});

describe('LoginForm password reset link (EMAIL.md §4.3)', () => {
  it('offers "Forgot password?" while signing in, not while creating an account', () => {
    renderForm();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull();
  });
});

describe('LoginForm bot protection', { timeout: 20_000, retry: 2 }, () => {
  it('sign-in asks for nothing up front; the guest form fetches its config but shows its widget only once used', async () => {
    renderForm();
    await waitFor(() => expect(configSurfaces()).toEqual(['guest']));
    expect(altchaWidget()).toBeNull();
    fireEvent.focus(screen.getByLabelText('Guest display name'));
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    expect(altchaWidget()!.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=guest');
  });

  it('a guest goes through the guest surface with its token', async () => {
    renderForm();
    fireEvent.focus(screen.getByLabelText('Guest display name'));
    fireEvent.change(screen.getByLabelText('Guest display name'), { target: { value: 'Ada' } });
    await waitFor(() => expect(altchaWidget()).not.toBeNull());
    vi.setSystemTime(BASE_TIME + 5_000);
    await solveAltcha('pow-guest');
    fireEvent.click(screen.getByRole('button', { name: 'Continue as guest' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/lobby'));
    expect(bodiesFor(fetchMock, '/api/auth/guest')[0]).toEqual({
      displayNameSeed: 'Ada',
      captchaToken: 'pow-guest',
      captchaProvider: 'altcha',
      formToken: '1790000000000.guest.mac',
    });
  });

  it('a rate-limited guest sees how long to wait in their language, not the route’s English', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => jsonResponse(captchaConfig({ surface: url.includes('guest') ? 'guest' : 'login', required: false })));
    renderForm();
    await waitFor(() => expect(configSurfaces()).toEqual(['guest']));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'Rate limit exceeded', retryAfter: 90 }, 429));
    vi.setSystemTime(BASE_TIME + 5_000);
    fireEvent.change(screen.getByLabelText('Guest display name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue as guest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 2 minutes.');
    expect(screen.queryByText('Rate limit exceeded')).toBeNull();
  });

  it('after signing in, goes back to the page that sent the visitor here (?next=)', async () => {
    renderForm({ nextPath: '/settings/notifications' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/settings/notifications'));
  });

  it('without one, lands in the lobby', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/lobby'));
  });

  it('sign-up shows its challenge at once, and an invite code moves it to the invite surface', async () => {
    renderForm({ initialMode: 'register', initialInviteCode: 'ABCDEF' });
    await waitFor(() => expect(configSurfaces()).toContain('invite_register'));
    await waitFor(() => expect(altchaWidget()?.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=invite_register'));
    fireEvent.change(screen.getByLabelText('Invite code (optional)'), { target: { value: '' } });
    await waitFor(() => expect(configSurfaces()).toContain('register'));
    await waitFor(() => expect(altchaWidget()?.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=register'));
  });
});
