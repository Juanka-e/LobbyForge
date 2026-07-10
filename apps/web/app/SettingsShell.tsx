'use client';

import { usePathname } from 'next/navigation';
import { createContext, useContext, type ReactNode } from 'react';
import SettingsModalFrame from './SettingsModalFrame';

type NavItem = { href: string; label: string; icon: string };

/**
 * Canonical settings shell — used by every page under /admin/* and
 * /settings/*. Server components wrap their content in this client
 * component, which renders the sidebar + content area and uses
 * usePathname() to highlight the active route.
 *
 * Adding a new settings page:
 *   1. Drop the href into COMMUNITY_NAV or USER_NAV below.
 *   2. Create the route at apps/web/app/<href>/page.tsx.
 *   3. Wrap the page body with <SettingsShell scope="community|user">.
 *
 * Do not inline-style the sidebar — the shell is the single source of
 * truth for visual rhythm (width, divider, hover, active) across all
 * settings surfaces.
 */

const COMMUNITY_NAV: NavItem[] = [
  { href: '/admin/settings', label: 'Overview', icon: 'dashboard' },
  { href: '/admin/settings/members', label: 'Members', icon: 'group' },
  { href: '/admin/settings/channels', label: 'Channels', icon: 'forum' },
  { href: '/admin/settings/roles', label: 'Roles & Permissions', icon: 'shield' },
  { href: '/admin/settings/invites', label: 'Invites', icon: 'qr_code_2' },
  { href: '/admin/settings/voice-media', label: 'Voice & Media', icon: 'mic' },
  { href: '/admin/bandwidth', label: 'Bandwidth', icon: 'data_usage' },
  { href: '/admin/settings/authentication', label: 'Authentication', icon: 'shield_lock' },
  { href: '/admin/settings/storage', label: 'Storage', icon: 'cloud_upload' },
  { href: '/admin/settings/backups', label: 'Backups', icon: 'backup' },
  { href: '/admin/audit', label: 'Audit Log', icon: 'history' },
  { href: '/admin/health', label: 'Doctor & Health', icon: 'health_and_safety' },
  { href: '/admin/updates', label: 'Updates', icon: 'system_update' },
];

const USER_NAV: NavItem[] = [
  { href: '/settings/my-account', label: 'My Account', icon: 'manage_accounts' },
  { href: '/settings/profile', label: 'Profile', icon: 'person' },
  { href: '/settings/appearance', label: 'Appearance', icon: 'palette' },
  { href: '/settings/accessibility', label: 'Accessibility', icon: 'accessibility_new' },
  { href: '/settings/voice-video', label: 'Voice & Video', icon: 'videocam' },
  { href: '/settings/keybinds', label: 'Keybinds', icon: 'keyboard' },
  { href: '/settings', label: 'Privacy & Activity', icon: 'visibility_lock' },
  { href: '/settings/active-sessions', label: 'Active Sessions', icon: 'devices' },
  { href: '/settings/notifications', label: 'Notifications', icon: 'notifications' },
];

const SettingsShellContext = createContext(false);

export default function SettingsShell({ scope, children }: { scope: 'community' | 'user'; children: ReactNode }) {
  const nested = useContext(SettingsShellContext);
  const pathname = usePathname();
  const nav = scope === 'community' ? COMMUNITY_NAV : USER_NAV;
  const title = scope === 'community' ? 'Community Settings' : 'User Settings';

  // Route layouts own the canonical shell. Keep legacy page-level wrappers
  // harmless while those pages are migrated independently.
  if (nested) return children;

  return (
    <SettingsShellContext.Provider value>
    <SettingsModalFrame label={title}>
    <div className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      <aside className="flex-none border-b border-border-subtle bg-surface md:w-64 md:border-b-0 md:border-r">
        <div className="h-16 px-5 pr-16 flex items-center border-b border-border-subtle md:pr-5">
          <div className="min-w-0">
            <p className="truncate text-xs text-text-muted">LobbyForge</p>
            <h1 className="truncate text-balance text-sm font-semibold text-text-primary">{title}</h1>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-2 md:block md:space-y-1 md:p-3" aria-label={title}>
          {nav.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== '/settings' && item.href !== '/admin/settings' && pathname.startsWith(`${item.href}/`));
            return (
              <a
                key={item.href}
                href={item.href}
                className={active
                  ? 'flex min-w-max items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary'
                  : 'flex min-w-max items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary'}
              >
                <span className="material-symbols-outlined text-lg" aria-hidden>{item.icon}</span>
                {item.label}
              </a>
            );
          })}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-8 md:px-10 md:py-10 lg:px-14">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
    </SettingsModalFrame>
    </SettingsShellContext.Provider>
  );
}
