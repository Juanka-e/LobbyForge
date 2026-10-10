// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { GuestVerificationDialog } from '../GuestVerificationDialog';
import { altchaWidget, bodiesFor, captchaConfig, jsonResponse, solveAltcha } from './captcha-test-utils';

const altcha = vi.hoisted(() => ({ loadAltcha: vi.fn(), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altcha);

const BASE_TIME = new Date('2026-10-04T10:00:00Z').getTime();
const GUEST = { gid: 'g_1', uid: 'user-1', name: 'Guest Ada' };

const renderIn = (ui: ReactElement, locale = 'en') => render(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);

let guestAnswers: Response[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/auth/captcha?surface=guest') return jsonResponse(captchaConfig({ surface: 'guest' }));
  if (url === '/api/auth/guest') return guestAnswers.shift() ?? jsonResponse({ guest: GUEST });
  return jsonResponse({}, 404);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME);
  guestAnswers = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  altcha.loadAltcha.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openSolved(props: Partial<Parameters<typeof GuestVerificationDialog>[0]> = {}) {
  const onVerified = vi.fn();
  const onDismiss = vi.fn();
  renderIn(<GuestVerificationDialog open onVerified={onVerified} onDismiss={onDismiss} {...props} />);
  await waitFor(() => expect(altchaWidget()).not.toBeNull());
  vi.setSystemTime(BASE_TIME + 3_000);
  await solveAltcha('pow-guest');
  return { onVerified, onDismiss };
}

describe('GuestVerificationDialog', { timeout: 20_000, retry: 2 }, () => {
  it('renders nothing while closed', () => {
    renderIn(<GuestVerificationDialog open={false} onVerified={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a labelled dialog with the guest challenge and a way to sign in instead — and come back', async () => {
    window.history.replaceState({}, '', '/room/game-night?serverId=s1&channelId=c1');
    try {
      await openSolved();
      const dialog = screen.getByRole('dialog', { name: 'One quick check' });
      expect(dialog).toHaveTextContent('Confirm you are not a bot to continue as a guest.');
      expect(altchaWidget()!.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=guest');
      expect(screen.getByRole('link', { name: 'Sign in with an account instead' })).toHaveAttribute(
        'href',
        `/login?next=${encodeURIComponent('/room/game-night?serverId=s1&channelId=c1')}`
      );
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('creates the guest with the token, the formToken and the page’s own fields', async () => {
    const { onVerified } = await openSolved({ body: { displayNameSeed: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(GUEST));
    expect(bodiesFor(fetchMock, '/api/auth/guest')).toEqual([
      { displayNameSeed: 'Ada', captchaToken: 'pow-guest', captchaProvider: 'altcha', formToken: '1790000000000.guest.mac' },
    ]);
  });

  it('stays open and says why when the token is refused — no silent retry', async () => {
    guestAnswers = [jsonResponse({ error: 'captcha_invalid' }, 400)];
    const { onVerified } = await openSolved();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Wait for this exact message: the reset widget can show its own status
    // alert first under a loaded run, and that one is not what is under test.
    const refusal = await screen.findByText('Verification failed, try again.');
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(onVerified).not.toHaveBeenCalled();
    expect(bodiesFor(fetchMock, '/api/auth/guest')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('says how long to wait after a rate limit, translated', async () => {
    guestAnswers = [jsonResponse({ error: 'Rate limit exceeded', retryAfter: 30 }, 429)];
    await openSolved();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 1 minute.');
  });

  it('reports another failure with its status', async () => {
    guestAnswers = [jsonResponse({ error: 'Guest access is disabled' }, 403)];
    await openSolved();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start your session (403).');
  });

  it('closes on its close button and on Escape', async () => {
    const { onDismiss } = await openSolved();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('speaks Turkish', async () => {
    renderIn(<GuestVerificationDialog open onVerified={vi.fn()} onDismiss={vi.fn()} />, 'tr');
    expect(await screen.findByRole('dialog', { name: 'Kısa bir kontrol' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Devam et' })).toBeInTheDocument();
  });
});
