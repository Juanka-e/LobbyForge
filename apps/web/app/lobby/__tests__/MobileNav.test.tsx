// @vitest-environment happy-dom
/**
 * Browser test finding (HIGH): on a phone the navigation drawer opened
 * empty — the channel sidebar inside it was `hidden md:flex`. The drawer
 * now carries the whole sidebar and behaves as a modal dialog below `md`:
 * focus moves in and is kept there, Escape / the backdrop / picking a
 * destination close it, and focus returns to the menu button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import MobileNav from '../MobileNav';
import { LobbyTextChannels } from '../LobbyTextChannels';
import { LobbyVoiceContext, type LobbyVoiceContextValue } from '../LobbyVoiceProvider';
import { makeVoice } from './voice-context';

const CHANNELS = [
  { id: 'ch-general', name: 'general', category: 'text' as const },
  { id: 'ch-clips', name: 'clips', category: 'text' as const },
];

function renderNav(voice: LobbyVoiceContextValue = makeVoice({ activeTextChannelId: 'ch-general' }), locale = 'en') {
  return render(
    <I18nProvider {...providerPropsFor(locale)}>
      <LobbyVoiceContext.Provider value={voice}>
        <MobileNav>
          <nav>
            <a href="/lobby?server=srv-2">Other community</a>
            <LobbyTextChannels channels={CHANNELS} />
            <button type="button">Mute</button>
          </nav>
        </MobileNav>
        <main>
          <button type="button">Centre column</button>
        </main>
      </LobbyVoiceContext.Provider>
    </I18nProvider>
  );
}

const drawer = () => screen.getByTestId('mobile-nav-drawer');
const menuButton = () => screen.getByRole('button', { name: 'Open navigation menu' });

beforeEach(() => {
  // A phone-sized viewport: the `md` query does not match.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MobileNav', () => {
  it('keeps the closed drawer out of the tab order and the accessibility tree', () => {
    renderNav();
    expect(drawer().dataset.open).toBe('false');
    // `invisible` (visibility: hidden) below md; `md:visible` restores the desktop sidebar.
    expect(drawer().className).toMatch(/(^|\s)invisible(\s|$)/);
    expect(drawer().className).toMatch(/md:visible/);
    expect(drawer().className).toMatch(/md:static/);
    expect(drawer()).not.toHaveAttribute('role');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveAttribute('aria-controls', drawer().id);
  });

  it('opens as a modal dialog with the channels in it and moves focus inside', async () => {
    renderNav();
    fireEvent.click(menuButton());

    const dialog = screen.getByRole('dialog', { name: 'Servers and channels' });
    expect(dialog).toBe(drawer());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toMatch(/(^|\s)visible(\s|$)/);
    // Found in Chromium: a `hidden → visible` transition is still hidden on
    // its first frame and focus() is refused, so opening must not transition
    // visibility (closing does, so the slide-out stays visible).
    expect(dialog.className).not.toMatch(/transition-\[transform,visibility\]/);
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('button', { name: /general/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /clips/ })).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true), { timeout: 5000 });
  });

  it('closes when a channel is picked, switches to it and returns focus to the menu button', async () => {
    const voice = makeVoice({ activeTextChannelId: 'ch-general' });
    renderNav(voice);
    fireEvent.click(menuButton());
    fireEvent.click(within(drawer()).getByRole('button', { name: /clips/ }));

    expect(voice.setActiveTextChannel).toHaveBeenCalledWith('ch-clips', 'clips');
    expect(drawer().dataset.open).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(menuButton()), { timeout: 5000 });
  });

  it('closes when a link is followed, but not for other controls', () => {
    renderNav();
    fireEvent.click(menuButton());
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Mute' }));
    expect(drawer().dataset.open).toBe('true');

    const link = within(drawer()).getByRole('link', { name: 'Other community' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(drawer().dataset.open).toBe('false');
  });

  it('closes on Escape and on the backdrop', async () => {
    renderNav();
    fireEvent.click(menuButton());
    await waitFor(() => expect(drawer().contains(document.activeElement)).toBe(true), { timeout: 5000 });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(drawer().dataset.open).toBe('false');

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));
    expect(drawer().dataset.open).toBe('false');
  });

  it('has a labelled close button and keeps Tab inside the open drawer', async () => {
    renderNav();
    fireEvent.click(menuButton());
    const close = within(drawer()).getByRole('button', { name: 'Close navigation menu' });
    const first = within(drawer()).getByRole('link', { name: 'Other community' });

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(drawer().dataset.open).toBe('false');
  });

  it('closes when the window grows past the md breakpoint', () => {
    let listener: ((event: { matches: boolean }) => void) | null = null;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
          listener = fn;
        },
        removeEventListener: vi.fn(),
      }))
    );
    renderNav();
    fireEvent.click(menuButton());
    expect(drawer().dataset.open).toBe('true');
    expect(listener).not.toBeNull();
    act(() => listener!({ matches: true }));
    expect(drawer().dataset.open).toBe('false');
  });

  it('says it in Turkish', () => {
    renderNav(undefined, 'tr');
    fireEvent.click(screen.getByRole('button', { name: 'Gezinme menüsünü aç' }));
    expect(screen.getByRole('dialog', { name: 'Sunucular ve kanallar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gezinme menüsünü kapat' })).toBeTruthy();
  });
});

describe('lobby sidebar markup', () => {
  it('renders the channel sidebar at every width (the drawer carries it on phones)', () => {
    const source = readFileSync(join(process.cwd(), 'app', 'lobby', 'page.tsx'), 'utf8');
    const sidebar = source.slice(source.indexOf('async function Sidebar('), source.indexOf('function buildKnownNames('));
    expect(sidebar).not.toMatch(/className="[^"]*hidden md:flex/);
    expect(sidebar).toMatch(/className="flex w-\[240px\]/);
  });

  it('leaves room for the phone menu button in every centre-column header', () => {
    for (const file of ['LobbyMainArea.tsx', 'LobbyDmView.tsx', 'LobbyActivityView.tsx']) {
      const header = readFileSync(join(process.cwd(), 'app', 'lobby', file), 'utf8').match(/<header className="h-16 ([^"]*)"/);
      expect(header?.[1], file).toMatch(/(^|\s)pl-16(\s|$)/);
      expect(header?.[1], file).toMatch(/md:pl-6/);
    }
  });
});
