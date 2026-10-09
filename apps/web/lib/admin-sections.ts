/**
 * The admin area's sections: which page each one is, the order the
 * settings nav lists them in, and whether a section manages the instance
 * or the community.
 *
 * Client-safe on purpose — there is no permission logic here. Who may open
 * a section is decided on the server (`lib/admin-access.ts`); client
 * components receive the list of sections the viewer may open, or ready
 * links, and only decide what to draw. A control that leads somewhere the
 * viewer cannot use is never drawn.
 */

export const ADMIN_SECTIONS = [
  'overview',
  'members',
  'channels',
  'roles',
  'invites',
  'voiceMedia',
  'apps',
  'bots',
  'plugins',
  'bandwidth',
  'authentication',
  'email',
  'storage',
  'backups',
  'audit',
  'moderation',
  'health',
  'updates',
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * Sections that manage the community (its members, channels, roles …).
 * Everything else manages the instance and is for its owner alone.
 */
export const COMMUNITY_ADMIN_SECTIONS = [
  'members',
  'channels',
  'roles',
  'invites',
  'voiceMedia',
  'apps',
  'bots',
  'audit',
] as const satisfies readonly AdminSection[];

export type CommunityAdminSection = (typeof COMMUNITY_ADMIN_SECTIONS)[number];

export function isCommunityAdminSection(section: AdminSection): section is CommunityAdminSection {
  return (COMMUNITY_ADMIN_SECTIONS as readonly AdminSection[]).includes(section);
}

/** The page each section is. */
export const ADMIN_SECTION_PATH: Record<AdminSection, string> = {
  overview: '/admin/settings',
  members: '/admin/settings/members',
  channels: '/admin/settings/channels',
  roles: '/admin/settings/roles',
  invites: '/admin/settings/invites',
  voiceMedia: '/admin/settings/voice-media',
  apps: '/admin/apps',
  bots: '/admin/settings/bots',
  plugins: '/admin/plugins',
  bandwidth: '/admin/bandwidth',
  authentication: '/admin/settings/authentication',
  email: '/admin/settings/email',
  storage: '/admin/settings/storage',
  backups: '/admin/settings/backups',
  audit: '/admin/audit',
  moderation: '/admin/moderation',
  health: '/admin/health',
  updates: '/admin/updates',
};

/**
 * The section an `/admin` path belongs to, or null. A page below a section
 * (`/admin/updates/<run>`) belongs to it; the overview (`/admin/settings`)
 * is matched exactly, since the other settings pages sit below it.
 */
export function adminSectionForPath(pathname: string): AdminSection | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: AdminSection | null = null;
  for (const section of ADMIN_SECTIONS) {
    const base = ADMIN_SECTION_PATH[section];
    const matches = path === base || (section !== 'overview' && path.startsWith(`${base}/`));
    if (matches && (!best || base.length > ADMIN_SECTION_PATH[best].length)) best = section;
  }
  return best;
}

/** A community-menu entry; `labelKey` is a message key, resolved where it renders. */
export interface AdminMenuLink {
  href: string;
  icon: string;
  labelKey: string;
}

/**
 * Every lobby control that leads into settings, already resolved for one
 * viewer: an entry is present only when its page will open for them, and
 * null means "draw no control".
 */
export interface LobbyAdminLinks {
  /** The community menu's settings entries, in menu order. */
  menu: AdminMenuLink[];
  /** The voice channel gear. */
  channelSettings: string | null;
  /** "Install apps" in the activities list and hub. */
  appSettings: string | null;
  /** "Bot settings" in a bot's profile. */
  botSettings: string | null;
}

export const NO_LOBBY_ADMIN_LINKS: LobbyAdminLinks = Object.freeze({
  menu: [],
  channelSettings: null,
  appSettings: null,
  botSettings: null,
}) as LobbyAdminLinks;

const LOBBY_MENU: ReadonlyArray<{ section: AdminSection; icon: string; labelKey: string }> = [
  { section: 'members', icon: 'group', labelKey: 'lobby.server.members' },
  { section: 'channels', icon: 'forum', labelKey: 'lobby.server.channels' },
  { section: 'roles', icon: 'shield', labelKey: 'lobby.server.roles' },
  { section: 'invites', icon: 'link', labelKey: 'lobby.server.invites' },
  { section: 'apps', icon: 'extension', labelKey: 'lobby.server.apps' },
  { section: 'health', icon: 'health_and_safety', labelKey: 'lobby.server.health' },
];

/**
 * The lobby's settings links for a viewer who may open `sections`.
 *
 * `serverSettingsHref` is the official hub's per-community settings page
 * (`/servers/{id}`), passed only when the viewer manages the community in
 * view: on the hub, `/admin` belongs to the operator, and a community's
 * own managers are sent there instead.
 */
export function buildLobbyAdminLinks({
  sections,
  serverSettingsHref = null,
}: {
  sections: readonly AdminSection[];
  serverSettingsHref?: string | null;
}): LobbyAdminLinks {
  const has = (section: AdminSection) => sections.includes(section);
  const menu: AdminMenuLink[] = [];
  const settingsHref = serverSettingsHref ?? (has('overview') ? ADMIN_SECTION_PATH.overview : null);
  if (settingsHref) {
    menu.push({ href: settingsHref, icon: 'admin_panel_settings', labelKey: 'lobby.server.settings' });
  }
  for (const entry of LOBBY_MENU) {
    if (has(entry.section)) {
      menu.push({ href: ADMIN_SECTION_PATH[entry.section], icon: entry.icon, labelKey: entry.labelKey });
    }
  }
  return {
    menu,
    channelSettings: has('channels') ? ADMIN_SECTION_PATH.channels : null,
    appSettings: has('apps') ? ADMIN_SECTION_PATH.apps : serverSettingsHref ? `${serverSettingsHref}?tab=apps` : null,
    botSettings: has('bots') ? ADMIN_SECTION_PATH.bots : null,
  };
}
