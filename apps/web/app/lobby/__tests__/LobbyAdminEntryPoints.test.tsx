// @vitest-environment happy-dom
/**
 * Nobody sees a control that leads somewhere they cannot use. Every lobby
 * entry into settings — the community menu, the voice channel gear, the
 * channel hints, "install an app", the bot profile's settings link and
 * the header's health link — is drawn only from links the server resolved
 * with the page guard's own rules (lib/admin-access.ts →
 * buildLobbyAdminLinks). A guest or member gets none of them; a moderator
 * gets exactly the pages that will open for them.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { ADMIN_SECTIONS, buildLobbyAdminLinks, type AdminSection } from '@/lib/admin-sections';
import { LobbyServerMenu, buildServerMenuItems } from '../LobbyServerMenu';
import { LobbyVoiceChannels } from '../LobbyVoiceChannels';
import { LobbyTextChannels } from '../LobbyTextChannels';
import { LobbyAppsSection } from '../LobbyAppsSection';
import { LobbyVoiceContext } from '../LobbyVoiceProvider';
import { makeVoice } from './voice-context';
import { __resetEmailStatusStoreForTests } from '@/components/email-verification/email-status-store';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/connect' }));

/** The viewers this fix is about, as the sections the guard would give them. */
const VIEWERS: Record<string, readonly AdminSection[]> = {
  guest: [],
  member: [],
  'moderator (Kick Members)': ['members'],
  'channel manager': ['channels'],
  owner: ADMIN_SECTIONS,
};

function wrap(ui: ReactNode) {
  return render(<I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>);
}

beforeEach(() => {
  __resetEmailStatusStoreForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ presences: [] }), { status: 200 }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the community menu', () => {
  function openMenu(sections: readonly AdminSection[]) {
    wrap(
      <LobbyServerMenu
        serverName="Night Owls"
        instanceLogoUrl={null}
        serverId="srv-1"
        adminMenu={buildLobbyAdminLinks({ sections }).menu}
        isOfficial={false}
      />
    );
    fireEvent.click(screen.getByTitle(/open the community menu/));
    return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
  }

  it.each(['guest', 'member'])('offers a %s only their own user settings', (viewer) => {
    expect(openMenu(VIEWERS[viewer]!)).toEqual(['manage_accountsUser settings']);
  });

  it('offers a moderator with Kick Members Members, and nothing else of the admin area', () => {
    expect(openMenu(VIEWERS['moderator (Kick Members)']!)).toEqual(['groupMembers', 'manage_accountsUser settings']);
  });

  it('offers the owner every settings entry', () => {
    expect(openMenu(VIEWERS.owner!)).toEqual([
      'admin_panel_settingsServer settings',
      'groupMembers',
      'forumChannels',
      'shieldRoles & permissions',
      'linkInvites',
      'extensionApps & activities',
      'health_and_safetyDoctor & health',
      'manage_accountsUser settings',
    ]);
  });

  it('builds the items from the resolved links only', () => {
    expect(buildServerMenuItems({ adminMenu: [], isOfficial: false }).map((item) => item.href)).toEqual(['/settings']);
    expect(
      buildServerMenuItems({ adminMenu: buildLobbyAdminLinks({ sections: ['audit'] }).menu, isOfficial: false }).map(
        (item) => item.href
      )
    ).toEqual(['/settings']);
  });
});

describe('the voice channel gear', () => {
  function renderVoice(channelSettingsHref: string | null) {
    wrap(
      <LobbyVoiceContext.Provider value={makeVoice()}>
        <LobbyVoiceChannels
          channels={[{ id: 'ch-lounge', name: 'Main Lounge', category: 'voice' }]}
          currentUserId="u-me"
          channelSettingsHref={channelSettingsHref}
        />
      </LobbyVoiceContext.Provider>
    );
  }

  it.each(['guest', 'member', 'moderator (Kick Members)'])('is not drawn for a %s', (viewer) => {
    renderVoice(buildLobbyAdminLinks({ sections: VIEWERS[viewer]! }).channelSettings);
    expect(screen.queryByRole('link', { name: 'Settings for Main Lounge' })).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it.each(['channel manager', 'owner'])('leads a %s to the channel settings', (viewer) => {
    renderVoice(buildLobbyAdminLinks({ sections: VIEWERS[viewer]! }).channelSettings);
    expect(screen.getByRole('link', { name: 'Settings for Main Lounge' })).toHaveAttribute(
      'href',
      '/admin/settings/channels'
    );
  });
});

describe('the text channel hints', () => {
  function renderText(channelSettingsHref: string | null) {
    return wrap(
      <LobbyVoiceContext.Provider value={makeVoice({ activeTextChannelId: 'ch-general' })}>
        <LobbyTextChannels
          channels={[{ id: 'ch-general', name: 'general', category: 'text' }]}
          channelSettingsHref={channelSettingsHref}
        />
      </LobbyVoiceContext.Provider>
    );
  }

  it('shows no settings or add hint to someone who cannot manage channels', () => {
    const { container } = renderText(null);
    const glyphs = Array.from(container.querySelectorAll('.material-symbols-outlined')).map((el) => el.textContent);
    expect(glyphs).not.toContain('settings');
    expect(glyphs).not.toContain('add');
  });

  it('keeps them for a channel manager', () => {
    const { container } = renderText('/admin/settings/channels');
    const glyphs = Array.from(container.querySelectorAll('.material-symbols-outlined')).map((el) => el.textContent);
    expect(glyphs).toContain('settings');
    expect(glyphs).toContain('add');
  });
});

describe('installing apps from the activities list', () => {
  function renderApps(appSettingsHref: string | null) {
    wrap(
      <LobbyVoiceContext.Provider value={makeVoice()}>
        <LobbyAppsSection
          apps={[]}
          serverId="srv-1"
          voiceChannelId="ch-lounge"
          voiceChannelName="Main Lounge"
          appSettingsHref={appSettingsHref}
        />
      </LobbyVoiceContext.Provider>
    );
  }

  it.each(['guest', 'member', 'moderator (Kick Members)'])('offers a %s no install link', (viewer) => {
    renderApps(buildLobbyAdminLinks({ sections: VIEWERS[viewer]! }).appSettings);
    expect(screen.queryByRole('link', { name: 'Install or remove apps' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'install one' })).toBeNull();
  });

  it('offers the owner both', () => {
    renderApps(buildLobbyAdminLinks({ sections: VIEWERS.owner! }).appSettings);
    expect(screen.getByRole('link', { name: 'Install or remove apps' })).toHaveAttribute('href', '/admin/apps');
    expect(screen.getByRole('link', { name: 'install one' })).toHaveAttribute('href', '/admin/apps');
  });

  it('sends a hub community manager to the community’s own apps tab', () => {
    renderApps(buildLobbyAdminLinks({ sections: [], serverSettingsHref: '/servers/srv-1' }).appSettings);
    expect(screen.getByRole('link', { name: 'Install or remove apps' })).toHaveAttribute(
      'href',
      '/servers/srv-1?tab=apps'
    );
  });
});

describe('the header health link', () => {
  it('is only there for the instance admin', async () => {
    const { default: GlobalHeader } = await import('@/app/GlobalHeader');
    wrap(<GlobalHeader />);
    expect(screen.queryByRole('link', { name: 'System Health' })).toBeNull();
    cleanup();
    wrap(<GlobalHeader showHealth />);
    expect(screen.getByRole('link', { name: 'System Health' })).toHaveAttribute('href', '/admin/health');
  });
});
