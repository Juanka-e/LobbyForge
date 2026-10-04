// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import SettingsPage from '../page';
import AppearanceSettingsPage from '../appearance/page';
import NotificationsSettingsPage from '../notifications/page';
import VoiceVideoSettingsPage from '../voice-video/page';

/**
 * A settings page opened without a session used to mint a fresh guest
 * (`POST /api/auth/guest`). With bot protection a new guest needs a
 * challenge these pages cannot show — and a brand-new identity's settings
 * are not what the visitor came for anyway. They now send the visitor to
 * sign in and come back (`/login?next=…`), like the lobby does.
 */

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/app/SettingsShell', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let meStatus = 401;
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/settings/me') {
    return new Response(JSON.stringify(meStatus === 401 ? { error: 'Unauthorized' } : { error: 'boom' }), { status: meStatus });
  }
  return new Response(JSON.stringify({ blocks: [] }), { status: 200 });
});

const PAGES: Array<[string, ComponentType, string]> = [
  ['privacy overview', SettingsPage, '/settings'],
  ['appearance', AppearanceSettingsPage, '/settings/appearance'],
  ['notifications', NotificationsSettingsPage, '/settings/notifications'],
  ['voice & video', VoiceVideoSettingsPage, '/settings/voice-video?tab=camera'],
];

function renderPage(Page: ComponentType) {
  return render(
    <I18nProvider {...providerPropsFor('en')}>
      <Page />
    </I18nProvider>
  );
}

beforeEach(() => {
  meStatus = 401;
  fetchMock.mockClear();
  nav.replace.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('settings pages without a session', { timeout: 20_000 }, () => {
  for (const [name, Page, path] of PAGES) {
    it(`${name}: sends the visitor to sign in and back, and never creates a guest`, async () => {
      window.history.replaceState({}, '', path);
      renderPage(Page);
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(path)}`));
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/guest')).toBe(false);
    });
  }

  it('another failure is a load error, not a trip to the sign-in page', async () => {
    meStatus = 500;
    window.history.replaceState({}, '', '/settings');
    const { findByText } = renderPage(SettingsPage);
    expect(await findByText('Failed to load settings.')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/guest')).toBe(false);
  });
});
