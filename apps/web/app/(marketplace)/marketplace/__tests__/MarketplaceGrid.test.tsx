// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MarketplaceGrid from '../MarketplaceGrid';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (ui: ReactElement) => rtlRender(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);

describe('MarketplaceGrid empty states', () => {
  it('offers to clear a search or category that matched nothing', () => {
    render(<MarketplaceGrid plugins={[]} filtered />);
    expect(screen.getByRole('heading', { name: 'No plugins match' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/marketplace');
  });

  it('tells an empty catalogue how plugins arrive and points at the publishing guide', () => {
    render(<MarketplaceGrid plugins={[]} />);
    expect(screen.getByRole('heading', { name: 'No community plugins yet' })).toBeInTheDocument();
    // The built-in activities have their own section above this one.
    expect(screen.getByText(/once they pass review/)).toBeInTheDocument();
    // The guide is rendered on the site's Developers section.
    expect(screen.getByRole('link', { name: 'Read the plugin publishing guide' })).toHaveAttribute(
      'href',
      '/developers/publishing'
    );
  });
});
