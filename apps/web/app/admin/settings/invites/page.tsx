import type { Metadata } from 'next';
import { inArray } from 'drizzle-orm';
import { listInvitesForServer, users } from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import InvitesClient, { type InviteView } from './InvitesClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('invites', 'adminSettings.invites.metaTitle');
}

/**
 * Every invite of the community, with revoke — Manage Community, as the
 * invites API requires for listing and revoking other people's invites.
 */
export default async function InvitesSettingsPage() {
  const access = await requireAdminSection('invites');
  const db = getDb();

  let serverId: string | null = null;
  let invites: InviteView[] = [];
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const firstServer = access.server;
      if (firstServer) {
        serverId = firstServer.id;
        const raw = await listInvitesForServer(db, firstServer.id);
        const creatorIds = Array.from(
          new Set(raw.map((row) => row.createdBy).filter((value): value is string => Boolean(value)))
        );
        const creatorMap = new Map<string, string>();
        if (creatorIds.length > 0) {
          const userRows = await db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, creatorIds));
          for (const row of userRows) creatorMap.set(row.id, row.name);
        }
        invites = raw.map((row) => ({
          id: row.id,
          serverId: row.serverId,
          createdBy: row.createdBy,
          creatorName: row.createdBy ? creatorMap.get(row.createdBy) ?? null : null,
          code: row.code,
          maxUses: row.maxUses,
          currentUses: row.currentUses,
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
        }));
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <InvitesClient
        serverId={serverId}
        initialInvites={invites}
        loadError={loadError}
        canMutate={Boolean(access.sessionUserId && serverId)}
      />
    </SettingsShell>
  );
}
