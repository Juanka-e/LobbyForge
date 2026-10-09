// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { ADMIN_SECTIONS, type AdminSection } from '@/lib/admin-sections';
import { SCROLL_REGION_FOCUS_CLASS } from '@/lib/scroll-region';

/**
 * Final-test finding (accessibility, axe `scrollable-region-focusable`):
 * the settings shell's scrolling <main> could not be reached from the
 * keyboard, so a page with nothing focusable inside could not be
 * scrolled. It now takes focus, has a name, and draws an inset,
 * keyboard-only focus ring.
 */

let pathname = '/admin/settings/members';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  pathname = '/admin/settings/members';
});

async function renderShell(
  scope: 'community' | 'user',
  locale = 'en',
  sections: readonly AdminSection[] = ADMIN_SECTIONS
) {
  const { default: SettingsShell } = await import('../SettingsShell');
  const body = <p>Read-only content with nothing focusable</p>;
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      {scope === 'community' ? (
        <SettingsShell scope="community" sections={sections}>
          {body}
        </SettingsShell>
      ) : (
        <SettingsShell scope="user">{body}</SettingsShell>
      )}
    </I18nProvider>
  );
}

/** The community nav's link targets, in order. */
function navHrefs(): string[] {
  const nav = screen.getByRole('navigation');
  return Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

describe('community settings nav', () => {
  it('lists every section for the instance admin', async () => {
    await renderShell('community');
    expect(navHrefs()).toHaveLength(ADMIN_SECTIONS.length);
    expect(navHrefs()[0]).toBe('/admin/settings');
  });

  it('shows a moderator with Kick Members only Members', async () => {
    await renderShell('community', 'en', ['members']);
    expect(navHrefs()).toEqual(['/admin/settings/members']);
    expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
  });

  it('keeps nav order for a mixed set of sections', async () => {
    await renderShell('community', 'en', ['audit', 'channels', 'members']);
    expect(navHrefs()).toEqual(['/admin/settings/members', '/admin/settings/channels', '/admin/audit']);
  });
});

describe('settings shell scroll region', () => {
  it('is focusable and named after the open section', async () => {
    await renderShell('community');
    const main = screen.getByRole('main', { name: 'Members' });
    expect(main.tabIndex).toBe(0);
    main.focus();
    expect(document.activeElement).toBe(main);
  });

  it('draws its focus ring inside the region and only for the keyboard', async () => {
    await renderShell('community');
    const main = screen.getByRole('main');
    for (const cls of SCROLL_REGION_FOCUS_CLASS.split(' ')) expect(main.classList).toContain(cls);
    expect(SCROLL_REGION_FOCUS_CLASS).toContain('focus-visible:outline-offset-[-2px]');
    expect(SCROLL_REGION_FOCUS_CLASS).not.toMatch(/(^|\s)focus:outline(\s|$)/);
    // Themed: the ring follows the accent token, never a hardcoded colour.
    expect(SCROLL_REGION_FOCUS_CLASS).toContain('focus-visible:outline-primary');
  });

  it('falls back to the shell title on a page outside the nav', async () => {
    pathname = '/settings/somewhere-new';
    await renderShell('user');
    expect(screen.getByRole('main', { name: 'User Settings' })).toBeTruthy();
  });

  it('is named in the viewer language', async () => {
    pathname = '/settings/profile';
    await renderShell('user', 'tr');
    expect(screen.getByRole('main', { name: 'Profil' })).toBeTruthy();
  });
});

describe('the hub server settings page', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'servers', '[id]', 'ServerSettingsClient.tsx'), 'utf8');

  it('makes its scrolling main focusable, named by the tab heading', () => {
    const main = source.slice(source.indexOf('<main'), source.indexOf('>', source.indexOf('className={`min-h-0', source.indexOf('<main'))));
    expect(main).toContain('tabIndex={0}');
    expect(main).toContain('aria-labelledby={tabHeadingId}');
    expect(main).toContain('${SCROLL_REGION_FOCUS_CLASS}');
    expect(source).toContain('<h2 id={tabHeadingId}');
  });
});
