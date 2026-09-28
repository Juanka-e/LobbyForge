// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import AccountMenu from '../AccountMenu';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
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

beforeEach(() => {
  nav.replace.mockReset();
  nav.refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountMenu', () => {
  it('names the account on its button and opens the account actions', async () => {
    const user = userEvent.setup();
    render(<AccountMenu name="Ada" />);
    const button = screen.getByRole('button', { name: 'Account menu for Ada' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Signed in as Ada')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('signs out through the logout endpoint and goes to the sign-in page', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'signed_out' }), { status: 200 }));
    const user = userEvent.setup();
    render(<AccountMenu name="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account menu for Ada' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    expect(nav.replace).toHaveBeenCalledWith('/login');
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('stays put and says so when signing out fails', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    const user = userEvent.setup();
    render(<AccountMenu name="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account menu for Ada' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out. Try again.');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the button', async () => {
    const user = userEvent.setup();
    render(<AccountMenu name="Ada" />);
    const button = screen.getByRole('button', { name: 'Account menu for Ada' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });
});
