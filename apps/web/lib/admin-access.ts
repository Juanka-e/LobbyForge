/**
 * Who may open which admin page — the one place that decides it.
 * Server-only.
 *
 * A viewer who may not open a page gets a real 404 (`notFound()`), thrown
 * before any admin UI renders or any of the page's data loads: the page is
 * indistinguishable from one that does not exist. Signed-out visitors and
 * guests get the same 404, so nothing advertises that an admin area
 * exists. Every page under `app/admin/**` calls `requireAdminSection` (and
 * `adminPageMetadata` for its title); `lib/__tests__/admin-pages-guarded.test.ts`
 * fails the build when one does not.
 *
 * Each section maps to the permissions its page actually serves, matching
 * the API routes it calls:
 *
 *   members     Kick Members, Ban Members, Manage Roles (its actions) or
 *               Manage Community (the join-request queue, lib/join-requests.ts)
 *   channels    Manage Channels (channel and webhook routes)
 *   roles       Manage Roles
 *   invites     Manage Community — the page lists and revokes EVERY invite,
 *               which the invites API allows only with it
 *   voiceMedia  Manage Community (voice-settings PATCH)
 *   apps        Manage Community (apps POST/DELETE)
 *   bots        Manage Community (requireBotManager)
 *   audit       View Audit Log (audit-logs GET)
 *
 * Everything else (overview, plugins & word packs, bandwidth,
 * authentication, email, storage, backups, moderation, health, updates)
 * manages the instance: its owner, or the operator token, alone — as every
 * `/api/admin` route requires. The owner holds every permission, so they
 * open every section. On the official hub `/admin` is the operator's;
 * a community's own managers use its `/servers/{id}` page instead.
 */
import { cache } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getInstanceSetupStatus,
  getServerById,
  getUserById,
  getUserPermissions,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getActiveSession } from '@/lib/active-session';
import {
  ADMIN_SECTIONS,
  isCommunityAdminSection,
  type AdminSection,
  type CommunityAdminSection,
} from '@/lib/admin-sections';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';

/** Any one of these opens the section (Administrator opens all of them). */
export const COMMUNITY_SECTION_PERMISSIONS: Record<CommunityAdminSection, readonly CorePermission[]> = {
  members: [
    CorePermission.KICK_MEMBERS,
    CorePermission.BAN_MEMBERS,
    CorePermission.MANAGE_ROLES,
    CorePermission.MANAGE_SERVER,
  ],
  channels: [CorePermission.MANAGE_CHANNELS],
  roles: [CorePermission.MANAGE_ROLES],
  invites: [CorePermission.MANAGE_SERVER],
  voiceMedia: [CorePermission.MANAGE_SERVER],
  apps: [CorePermission.MANAGE_SERVER],
  bots: [CorePermission.MANAGE_SERVER],
  audit: [CorePermission.VIEW_AUDIT_LOG],
};

/** What the decision rests on. */
export interface AdminViewerFacts {
  /** The instance owner's (unrevoked) session, or the operator token. */
  instanceAdmin: boolean;
  /** A guest account — never shown an admin page, whatever its roles say. */
  guest: boolean;
  /** The viewer's permissions on the community the admin pages manage. */
  permissions: readonly string[];
  /** The official hub, where `/admin` is the operator's alone. */
  official: boolean;
}

export function canOpenAdminSection(facts: AdminViewerFacts, section: AdminSection): boolean {
  if (facts.instanceAdmin) return true;
  if (facts.guest || facts.official) return false;
  if (!isCommunityAdminSection(section)) return false;
  const permissions = [...facts.permissions];
  return COMMUNITY_SECTION_PERMISSIONS[section].some((permission) => hasPermission(permissions, permission));
}

/** The sections the viewer may open, in nav order. */
export function allowedAdminSections(facts: AdminViewerFacts): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => canOpenAdminSection(facts, section));
}

export interface AdminAccess {
  instanceAdmin: boolean;
  guest: boolean;
  /** The signed-in account; null for the operator token without a session. */
  sessionUserId: string | null;
  /**
   * Whose community the pages show: the signed-in account's, or — for the
   * operator token without a session — the instance owner's, as before.
   */
  userId: string | null;
  /** The community the admin pages manage (the account's first). */
  server: { id: string; name: string; ownerUserId: string } | null;
  /** The signed-in account's permissions on `server`. */
  permissions: string[];
  /** What the viewer may open, in nav order — empty for most people. */
  sections: AdminSection[];
}

const NO_ACCESS: AdminAccess = Object.freeze({
  instanceAdmin: false,
  guest: false,
  sessionUserId: null,
  userId: null,
  server: null,
  permissions: [],
  sections: [],
}) as AdminAccess;

function sessionSecret(): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

/**
 * Resolve a request's admin access. Never throws: anything it cannot read
 * (no secret, a database error) closes the area — except to the instance
 * admin, who keeps it, and whose pages then report their own load errors.
 */
export async function resolveAdminAccess(input: {
  cookieHeader: string | null;
  adminToken: string | null;
  official: boolean;
}): Promise<AdminAccess> {
  const secret = sessionSecret();
  const [instanceAdmin, session] = await Promise.all([
    isInstanceAdminAllowed(input.cookieHeader, input.adminToken).catch(() => false),
    secret ? getActiveSession(input.cookieHeader, secret).catch(() => null) : Promise.resolve(null),
  ]);
  const sessionUserId = session?.uid ?? null;
  if (!instanceAdmin && !sessionUserId) return NO_ACCESS;

  try {
    const db = getDb();
    if (!instanceAdmin && sessionUserId) {
      const user = await getUserById(db, sessionUserId);
      if (!user) return NO_ACCESS;
      if (user.isGuest) return { ...NO_ACCESS, guest: true, sessionUserId, userId: sessionUserId };
    }
    const userId = sessionUserId ?? (await getInstanceSetupStatus(db)).ownerUserId ?? null;
    const first = userId ? (await listServersForUser(db, userId, { limit: 1 }))[0] ?? null : null;
    const permissions = first && sessionUserId ? await getUserPermissions(db, sessionUserId, first.id) : [];
    return {
      instanceAdmin,
      guest: false,
      sessionUserId,
      userId,
      server: first ? { id: first.id, name: first.name, ownerUserId: first.ownerUserId } : null,
      permissions,
      sections: allowedAdminSections({ instanceAdmin, guest: false, permissions, official: input.official }),
    };
  } catch {
    if (!instanceAdmin) return NO_ACCESS;
    return { ...NO_ACCESS, instanceAdmin: true, sessionUserId, userId: sessionUserId, sections: [...ADMIN_SECTIONS] };
  }
}

/** This request's admin access — one resolution per request. */
export const getAdminAccess = cache(async (): Promise<AdminAccess> => {
  const store = await cookies();
  return resolveAdminAccess({
    cookieHeader: store.toString(),
    adminToken: store.get(ADMIN_TOKEN_COOKIE)?.value ?? null,
    official: isOfficialDeployment(),
  });
});

/** The page's guard: its access, or a 404 for anyone who may not open it. */
export async function requireAdminSection(section: AdminSection): Promise<AdminAccess> {
  const access = await getAdminAccess();
  if (!access.sections.includes(section)) notFound();
  return access;
}

/** The admin area's own guard: a 404 for anyone who may open no section at all. */
export async function requireAdminArea(): Promise<AdminAccess> {
  const access = await getAdminAccess();
  if (access.sections.length === 0) notFound();
  return access;
}

/**
 * A guarded page's `generateMetadata`: the guard runs here too, so a
 * refused page does not give itself away in its title (and answers 404
 * before anything streams).
 */
export async function adminPageMetadata(section: AdminSection, titleKey: string): Promise<Metadata> {
  await requireAdminSection(section);
  const t = await getTranslator();
  return { title: t(titleKey) };
}

/**
 * The sections that apply to the community the lobby shows. The admin
 * pages manage the account's first community, so community sections only
 * count when that is the one in view; instance sections always do.
 */
export function adminSectionsForServer(access: AdminAccess, serverId: string | null): AdminSection[] {
  const sameServer = serverId !== null && access.server?.id === serverId;
  return access.sections.filter((section) => sameServer || !isCommunityAdminSection(section));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a community manager may do on its `/servers/{id}` settings page. */
export interface ServerSettingsAccess {
  userId: string;
  server: { id: string; name: string; ownerUserId: string };
  isOwner: boolean;
  can: {
    manageChannels: boolean;
    kickMembers: boolean;
    createInvite: boolean;
    viewAuditLog: boolean;
    /** Edit roles' permissions — e.g. who may create polls, from the Poll app's card. */
    manageRoles: boolean;
  };
}

/**
 * The guard for a community's settings page (`/servers/{id}`): a signed-in,
 * non-guest member holding Manage Community there — what its install,
 * access-policy and bot screens need. Anyone else, and an unknown or
 * malformed id, gets a 404.
 */
export const requireServerSettings = cache(async (serverId: string): Promise<ServerSettingsAccess> => {
  const secret = sessionSecret();
  if (!secret || !UUID_RE.test(serverId)) notFound();
  const store = await cookies();
  const session = await getActiveSession(store.toString(), secret).catch(() => null);
  const userId = session?.uid ?? null;
  if (!userId) notFound();

  let access: ServerSettingsAccess | null = null;
  try {
    const db = getDb();
    const [user, server] = await Promise.all([getUserById(db, userId), getServerById(db, serverId)]);
    if (user && !user.isGuest && server) {
      const permissions = await getUserPermissions(db, userId, server.id);
      if (hasPermission(permissions, CorePermission.MANAGE_SERVER)) {
        access = {
          userId,
          server: { id: server.id, name: server.name, ownerUserId: server.ownerUserId },
          isOwner: server.ownerUserId === userId,
          can: {
            manageChannels: hasPermission(permissions, CorePermission.MANAGE_CHANNELS),
            kickMembers: hasPermission(permissions, CorePermission.KICK_MEMBERS),
            createInvite: hasPermission(permissions, CorePermission.CREATE_INVITE),
            viewAuditLog: hasPermission(permissions, CorePermission.VIEW_AUDIT_LOG),
            manageRoles: hasPermission(permissions, CorePermission.MANAGE_ROLES),
          },
        };
      }
    }
  } catch {
    access = null;
  }
  if (!access) notFound();
  return access;
});
