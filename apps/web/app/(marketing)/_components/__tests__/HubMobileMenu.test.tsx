// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import HubMobileMenu from '../HubMobileMenu';
import type { HubNavLink } from '../HubNavLinks';

const nav = vi.hoisted(() => ({ pathname: '/landing' }));

vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (ui: ReactElement) => rtlRender(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);

const links: HubNavLink[] = [
  { kind: 'internal', href: '/discover', label: 'Communities' },
  { kind: 'internal', href: '/marketplace', label: 'Marketplace' },
  { kind: 'external', href: 'https://github.com/Juanka-e/LobbyForge/tree/main/docs', label: 'Docs' },
];

function renderMenu(signedIn = false) {
  return render(
    <div>
      <p>Outside the menu</p>
      <HubMobileMenu
        links={links}
        label="Primary"
        signedIn={signedIn}
        repoUrl="https://github.com/Juanka-e/LobbyForge"
        starLabel={{ text: 'Star on GitHub', count: '1.2K', countLabel: '(1,234 stars)' }}
      />
    </div>
  );
}

beforeEach(() => {
  nav.pathname = '/landing';
});

describe('HubMobileMenu', () => {
  it('starts closed: the button says so and the links are not exposed', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  it('opens on click and shows the page links and the sign-up actions', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: 'Menu' });
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('navigation', { name: 'Primary' });
    expect(menu).toBeVisible();
    expect(screen.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', '/marketplace');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', expect.stringContaining('/docs'));
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: /Star on GitHub.*\(1,234 stars\)/ })).toHaveAttribute(
      'href',
      'https://github.com/Juanka-e/LobbyForge'
    );
  });

  it('works from the keyboard, and Escape closes it and returns focus to the button', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: 'Menu' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    // The panel follows the button in the reading order.
    await user.tab();
    expect(screen.getByRole('link', { name: 'Communities' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('closes when a link is followed or when you click elsewhere', async () => {
    const user = userEvent.setup();
    renderMenu();
    const button = screen.getByRole('button', { name: 'Menu' });
    await user.click(button);
    await user.click(screen.getByRole('link', { name: 'Communities' }));
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    await user.click(screen.getByText('Outside the menu'));
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks the page being shown', async () => {
    nav.pathname = '/marketplace';
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Communities' })).not.toHaveAttribute('aria-current');
  });

  it('offers no sign-up actions to someone already signed in', async () => {
    const user = userEvent.setup();
    renderMenu(true);
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.queryByRole('link', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Star on GitHub/ })).not.toBeInTheDocument();
  });
});
