import { cookies } from 'next/headers';
import { inArray } from 'drizzle-orm';
import {
  getInstanceSetupStatus,
  listAuditLogsForServer,
  listServersForUser,
  users,
  type AuditLogRow,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import AuditClient, { type AuditEntryView } from './AuditClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Audit Log - Community Settings',
};

/**
 * Community Settings -> Audit Log.
 *
 * The audit log is append-only. Filtering and CSV export happen client-side
 * from the rows this authorized server component already loaded, avoiding an
 * extra export endpoint while the route permission model is still maturing.
 */
export default async function AuditLogPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Audit Log</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const setup = await getInstanceSetupStatus(getDb());
  const db = getDb();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let entries: AuditEntryView[] = [];
  let loadError: string | null = null;
  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        const rows: AuditLogRow[] = await listAuditLogsForServer(db, firstServer.id, {
          limit: 100,
        });
        const actorIds = Array.from(
          new Set(rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)))
        );
        const actorMap = new Map<string, string>();
        if (actorIds.length > 0) {
          const userRows = await db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(inArray(users.id, actorIds));
          for (const r of userRows) actorMap.set(r.id, r.name);
        }
        entries = rows.map((r) => ({
          id: r.id,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          metadata: r.metadata,
          actorName: r.actorUserId ? actorMap.get(r.actorUserId) ?? null : null,
          createdAt: r.createdAt.toISOString(),
        }));
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community">
      <AuditClient entries={entries} loadError={loadError} />
    </SettingsShell>
  );
}
