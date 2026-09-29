// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import OfficialSignInForm from '../OfficialSignInForm';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

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

const render = (ui: ReactElement, locale = 'en') =>
  rtlRender(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);
const fetchMock = vi.fn();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
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

describe('OfficialSignInForm', () => {
  it('signs in with the shared login endpoint and goes to the hub home', async () => {
    fetchMock.mockResolvedValue(json({ user: { id: 'u1' } }, 200));
    render(<OfficialSignInForm googleEnabled={false} initialError={null} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await fillAndSubmit('  ada@example.com ', 'correct-horse-battery');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ email: 'ada@example.com', password: 'correct-horse-battery' });
    expect(nav.replace).toHaveBeenCalledWith('/home');
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('explains a refused sign-in in the reader’s language and stays on the page', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Invalid email or password.' }, 401));
    render(<OfficialSignInForm googleEnabled={false} initialError={null} />, 'tr');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('E-posta'), 'ada@example.com');
    await user.type(screen.getByLabelText('Şifre'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu e-posta ve şifreyle eşleşen bir hesap yok.');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('tells a rate-limited visitor to wait', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Rate limit exceeded' }, 429));
    render(<OfficialSignInForm googleEnabled={false} initialError={null} />);
    await fillAndSubmit('ada@example.com', 'whatever-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });

  it('shows an error an auth redirect came back with', () => {
    render(<OfficialSignInForm googleEnabled={false} initialError="Google sign-in failed. Please try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Google sign-in failed. Please try again.');
  });

  it('offers Google only when it is configured, returning to the hub home', () => {
    const { unmount } = render(<OfficialSignInForm googleEnabled={false} initialError={null} />);
    expect(screen.queryByRole('link', { name: 'Continue with Google' })).not.toBeInTheDocument();
    unmount();
    render(<OfficialSignInForm googleEnabled initialError={null} />);
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/auth/oauth/google?redirect=%2Fhome'
    );
  });

  it('links to connecting by address and to creating an account', () => {
    render(<OfficialSignInForm googleEnabled={false} initialError={null} />);
    expect(screen.getByRole('link', { name: 'Connect to a community by address' })).toHaveAttribute('href', '/connect');
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register');
  });

  it('lets the password be shown with a toggle button', async () => {
    const user = userEvent.setup();
    render(<OfficialSignInForm googleEnabled={false} initialError={null} />);
    const password = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(password).toHaveAttribute('type', 'password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(password).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
