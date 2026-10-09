import { describe, expect, it } from 'vitest';
import {
  ADMIN_SECTIONS,
  ADMIN_SECTION_PATH,
  adminSectionForPath,
  buildLobbyAdminLinks,
  COMMUNITY_ADMIN_SECTIONS,
} from '@/lib/admin-sections';

describe('admin section paths', () => {
  it('gives every section its own page', () => {
    const paths = ADMIN_SECTIONS.map((section) => ADMIN_SECTION_PATH[section]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith('/admin/')).toBe(true);
  });

  it.each([...ADMIN_SECTIONS])('maps %s’s own path back to it', (section) => {
    expect(adminSectionForPath(ADMIN_SECTION_PATH[section])).toBe(section);
  });

  it('files a sub-page under its section, and the overview only on its own path', () => {
    expect(adminSectionForPath('/admin/updates/123')).toBe('updates');
    expect(adminSectionForPath('/admin/settings/members/')).toBe('members');
    expect(adminSectionForPath('/admin/settings/unknown')).toBeNull();
    expect(adminSectionForPath('/admin')).toBeNull();
    expect(adminSectionForPath('/settings/profile')).toBeNull();
  });
});

describe('the lobby’s settings links', () => {
  it('gives a viewer who may open nothing no link at all', () => {
    expect(buildLobbyAdminLinks({ sections: [] })).toEqual({
      menu: [],
      channelSettings: null,
      appSettings: null,
      botSettings: null,
    });
  });

  it('gives a moderator with Kick Members the Members entry and nothing else', () => {
    const links = buildLobbyAdminLinks({ sections: ['members'] });
    expect(links.menu.map((item) => item.href)).toEqual(['/admin/settings/members']);
    expect(links.channelSettings).toBeNull();
    expect(links.appSettings).toBeNull();
    expect(links.botSettings).toBeNull();
  });

  it('gives a channel manager the channel gear', () => {
    const links = buildLobbyAdminLinks({ sections: ['channels'] });
    expect(links.channelSettings).toBe('/admin/settings/channels');
    expect(links.menu.map((item) => item.labelKey)).toEqual(['lobby.server.channels']);
  });

  it('gives the instance admin every entry, settings first', () => {
    const links = buildLobbyAdminLinks({ sections: ADMIN_SECTIONS });
    expect(links.menu.map((item) => item.href)).toEqual([
      '/admin/settings',
      '/admin/settings/members',
      '/admin/settings/channels',
      '/admin/settings/roles',
      '/admin/settings/invites',
      '/admin/apps',
      '/admin/health',
    ]);
    expect(links).toMatchObject({
      channelSettings: '/admin/settings/channels',
      appSettings: '/admin/apps',
      botSettings: '/admin/settings/bots',
    });
  });

  it('a non-owner Administrator gets the community entries but not Health or the instance overview', () => {
    const links = buildLobbyAdminLinks({ sections: COMMUNITY_ADMIN_SECTIONS });
    const hrefs = links.menu.map((item) => item.href);
    expect(hrefs).not.toContain('/admin/settings');
    expect(hrefs).not.toContain('/admin/health');
    expect(hrefs).toContain('/admin/settings/members');
  });

  it('sends a hub community’s manager to its own settings page', () => {
    const links = buildLobbyAdminLinks({ sections: [], serverSettingsHref: '/servers/abc' });
    expect(links.menu).toEqual([
      { href: '/servers/abc', icon: 'admin_panel_settings', labelKey: 'lobby.server.settings' },
    ]);
    expect(links.appSettings).toBe('/servers/abc?tab=apps');
    expect(links.channelSettings).toBeNull();
  });
});
