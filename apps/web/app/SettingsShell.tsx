'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { createContext, useContext, type ReactNode } from 'react';
import { ADMIN_SECTIONS, ADMIN_SECTION_PATH, type AdminSection } from '@/lib/admin-sections';
import { useT } from '@/lib/i18n/client';
import { SCROLL_REGION_FOCUS_CLASS } from '@/lib/scroll-region';
import SettingsModalFrame from './SettingsModalFrame';

/**
 * `labelKey` is a message key, not text: these lists are module-level
 * constants with no translator in reach, so each label is resolved where
 * the nav renders.
 */
type NavItem = { href: string; labelKey: string; icon: string };

/**
 * Canonical settings shell — used by every page under /admin/* and
 * /settings/*. Server components wrap their content in this client
 * component, which renders the sidebar + content area and uses
 * usePathname() to highlight the active route.
 *
 * The community nav lists only the sections the viewer may open
 * (`sections`, from the page's `requireAdminSection` guard): a moderator
 * with Kick Members sees Members and nothing else, never a nav of links
 * that answer 404.
 *
 * Adding a new admin page:
 *   1. Add its section to `lib/admin-sections.ts` and its rule to
 *      `lib/admin-access.ts`, and its label/icon to COMMUNITY_NAV_META.
 *   2. Create the route at apps/web/app/<href>/page.tsx, guarded with
 *      `requireAdminSection` (a test fails the build otherwise).
 *   3. Wrap the page body with <SettingsShell scope="community" sections={access.sections}>.
 *
 * Do not inline-style the sidebar — the shell is the single source of
 * truth for visual rhythm (width, divider, hover, active) across all
 * settings surfaces.
 */

const COMMUNITY_NAV_META: Record<AdminSection, Omit<NavItem, 'href'>> = {
  overview: { labelKey: 'settings.nav.community.overview', icon: 'dashboard' },
  members: { labelKey: 'settings.nav.community.members', icon: 'group' },
  channels: { labelKey: 'settings.nav.community.channels', icon: 'forum' },
  roles: { labelKey: 'settings.nav.community.roles', icon: 'shield' },
  invites: { labelKey: 'settings.nav.community.invites', icon: 'qr_code_2' },
  voiceMedia: { labelKey: 'settings.nav.community.voiceMedia', icon: 'mic' },
  apps: { labelKey: 'settings.nav.community.apps', icon: 'stadia_controller' },
  bots: { labelKey: 'settings.nav.community.bots', icon: 'smart_toy' },
  plugins: { labelKey: 'settings.nav.community.plugins', icon: 'extension' },
  bandwidth: { labelKey: 'settings.nav.community.bandwidth', icon: 'data_usage' },
  authentication: { labelKey: 'settings.nav.community.authentication', icon: 'shield_lock' },
  email: { labelKey: 'settings.nav.community.email', icon: 'mail' },
  storage: { labelKey: 'settings.nav.community.storage', icon: 'cloud_upload' },
  backups: { labelKey: 'settings.nav.community.backups', icon: 'backup' },
  audit: { labelKey: 'settings.nav.community.audit', icon: 'history' },
  moderation: { labelKey: 'settings.nav.community.moderation', icon: 'gavel' },
  health: { labelKey: 'settings.nav.community.health', icon: 'health_and_safety' },
  updates: { labelKey: 'settings.nav.community.updates', icon: 'system_update' },
};

/** The community nav for a viewer who may open `sections`, in nav order. */
export function communityNav(sections: readonly AdminSection[]): NavItem[] {
  return ADMIN_SECTIONS.filter((section) => sections.includes(section)).map((section) => ({
    href: ADMIN_SECTION_PATH[section],
    ...COMMUNITY_NAV_META[section],
  }));
}

const USER_NAV: NavItem[] = [
  { href: '/settings/my-account', labelKey: 'settings.nav.user.account', icon: 'manage_accounts' },
  { href: '/settings/profile', labelKey: 'settings.nav.user.profile', icon: 'person' },
  { href: '/settings/appearance', labelKey: 'settings.nav.user.appearance', icon: 'palette' },
  { href: '/settings/accessibility', labelKey: 'settings.nav.user.accessibility', icon: 'accessibility_new' },
  { href: '/settings/voice-video', labelKey: 'settings.nav.user.voiceVideo', icon: 'videocam' },
  { href: '/settings/keybinds', labelKey: 'settings.nav.user.keybinds', icon: 'keyboard' },
  { href: '/settings', labelKey: 'settings.nav.user.privacy', icon: 'visibility_lock' },
  { href: '/settings/active-sessions', labelKey: 'settings.nav.user.sessions', icon: 'devices' },
  { href: '/settings/notifications', labelKey: 'settings.nav.user.notifications', icon: 'notifications' },
];

const SettingsShellContext = createContext(false);

type SettingsShellProps =
  | { scope: 'user'; children: ReactNode }
  /** `sections`: what the viewer may open — the page guard's `access.sections`. */
  | { scope: 'community'; sections: readonly AdminSection[]; children: ReactNode };

export default function SettingsShell(props: SettingsShellProps) {
  const { scope, children } = props;
  const t = useT();
  const nested = useContext(SettingsShellContext);
  const pathname = usePathname();
  const nav = props.scope === 'community' ? communityNav(props.sections) : USER_NAV;
  const title = t(scope === 'community' ? 'settings.nav.communityTitle' : 'settings.nav.userTitle');
  const isActive = (item: NavItem) =>
    pathname === item.href ||
    (item.href !== '/settings' && item.href !== '/admin/settings' && pathname.startsWith(`${item.href}/`));
  const activeItem = nav.find(isActive);

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
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active
                  ? 'flex min-w-max items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary'
                  : 'flex min-w-max items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary'}
              >
                <span className="material-symbols-outlined text-lg" aria-hidden>{item.icon}</span>
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </aside>
      {/* The scrolling region takes keyboard focus, named after the open
          section (see SCROLL_REGION_FOCUS_CLASS for why and how). */}
      <main
        tabIndex={0}
        aria-label={activeItem ? t(activeItem.labelKey) : title}
        className={`min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-8 md:px-10 md:py-10 lg:px-14 ${SCROLL_REGION_FOCUS_CLASS}`}
      >
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
    </SettingsModalFrame>
    </SettingsShellContext.Provider>
  );
}
