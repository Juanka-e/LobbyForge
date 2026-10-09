// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { altchaWidget, bodiesFor, captchaConfig, solveAltcha } from '@/components/captcha/__tests__/captcha-test-utils';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import OfficialSignUpForm from '../OfficialSignUpForm';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const altchaLoader = vi.hoisted(() => ({ loadAltcha: vi.fn(async () => {}), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altchaLoader);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (ui: ReactElement) => rtlRender(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);
const fetchMock = vi.fn();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fillForm(user: ReturnType<typeof userEvent.setup>, { agree = true } = {}) {
  await user.type(screen.getByLabelText('Display name'), '  Ada ');
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  if (agree) await user.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OfficialSignUpForm', { timeout: 20_000, retry: 2 }, () => {
  it('creates the account through the shared register endpoint and goes to the hub home', async () => {
    fetchMock.mockResolvedValue(json({ user: { id: 'u1' } }, 201));
    const user = userEvent.setup();
    render(<OfficialSignUpForm />);
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/register', expect.objectContaining({ method: 'POST' }));
    // The form also reads its bot-protection config; this mock answers that
    // with no usable config, so no captcha fields go out.
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/auth/register')!;
    expect(JSON.parse(init.body)).toEqual({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      displayName: 'Ada',
    });
    expect(nav.replace).toHaveBeenCalledWith('/home');
  });

  it('rates the password as it is typed, in words as well as bars', async () => {
    const user = userEvent.setup();
    render(<OfficialSignUpForm />);
    const password = screen.getByLabelText('Password');
    // The rating is the field's description, so it is read with the field.
    expect(password).toHaveAccessibleDescription('At least 12 characters');
    await user.type(password, 'short');
    expect(password).toHaveAccessibleDescription('Too short — at least 12 characters');
    await user.clear(password);
    await user.type(password, 'correct-horse-battery');
    expect(password).toHaveAccessibleDescription('Strong — at least 12 characters');
  });

  it('describes the display name field', () => {
    render(<OfficialSignUpForm />);
    expect(screen.getByLabelText('Display name')).toHaveAccessibleDescription('Shown to people in the rooms you join.');
  });

  it('links the Code of Conduct in a new tab, so the form is not lost', () => {
    render(<OfficialSignUpForm />);
    const link = screen.getByRole('link', { name: /Code of Conduct/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('CODE_OF_CONDUCT.md'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAccessibleName('Code of Conduct (opens in a new tab)');
  });

  it('explains a disposable address in words, never the code', async () => {
    fetchMock.mockResolvedValue(json({ error: 'disposable_email' }, 400));
    const user = userEvent.setup();
    render(<OfficialSignUpForm />);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Addresses from disposable email services can't be used here.");
  });

  it('explains an address that already has an account', async () => {
    fetchMock.mockResolvedValue(json({ error: 'An account with this email already exists.' }, 409));
    const user = userEvent.setup();
    render(<OfficialSignUpForm />);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists.');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('lets the captcha checkbox wait, but still requires the agreement', async () => {
    fetchMock.mockResolvedValue(json({ user: { id: 'u1' } }, 201));
    const user = userEvent.setup();
    render(<OfficialSignUpForm />);
    // The browser's own validation is off (the widget's checkbox would block an early submit)…
    expect(screen.getByRole('button', { name: 'Create account' }).closest('form')).toHaveAttribute('novalidate');
    // …so the form checks its own fields: no agreement, nothing sent.
    await fillForm(user, { agree: false });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/register')).toBe(false);
  });

  it('links back to signing in', () => {
    render(<OfficialSignUpForm />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('shows the sign-up challenge and sends its token with the formToken', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));
    try {
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/auth/captcha?surface=register'
          ? json(captchaConfig({ surface: 'register' }), 200)
          : json({ user: { id: 'u1' } }, 201)
      );
      const user = userEvent.setup();
      render(<OfficialSignUpForm />);
      await waitFor(() => expect(altchaWidget()).not.toBeNull());
      expect(altchaWidget()!.getAttribute('challenge')).toBe('/api/auth/captcha/challenge?surface=register');
      await fillForm(user);
      vi.setSystemTime(new Date('2026-10-04T10:00:05Z'));
      await solveAltcha('pow-signup');
      await user.click(screen.getByRole('button', { name: 'Create account' }));
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/home'));
      expect(bodiesFor(fetchMock, '/api/auth/register')[0]).toMatchObject({
        captchaToken: 'pow-signup',
        captchaProvider: 'altcha',
        formToken: '1790000000000.register.mac',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
