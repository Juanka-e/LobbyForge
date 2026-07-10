import { cookies } from 'next/headers';
import { inArray } from 'drizzle-orm';
import {
  getInstanceSetupStatus,
  listInvitesForServer,
  listServersForUser,
  users,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import InvitesClient, { type InviteView } from './InvitesClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Invites - Community Settings',
};

export default async function InvitesSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Invites</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const setup = await getInstanceSetupStatus(getDb());
  const db = getDb();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let serverId: string | null = null;
  let invites: InviteView[] = [];
  let loadError: string | null = null;

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
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
    <SettingsShell scope="community">
      <InvitesClient
        serverId={serverId}
        initialInvites={invites}
        loadError={loadError}
        canMutate={Boolean(session?.uid && serverId)}
      />
    </SettingsShell>
  );
}
