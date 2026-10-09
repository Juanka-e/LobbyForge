import type { Metadata } from 'next';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import type { AuditEntryView } from '@/lib/audit-event-summary';
import { loadAuditEntries } from '@/lib/audit-log-view';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import AuditClient from './AuditClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('audit', 'admin.audit.metaTitle');
}

/**
 * Community Settings -> Audit Log.
 *
 * The audit log is append-only. Filtering and CSV export happen client-side
 * from the rows this authorized server component already loaded, avoiding an
 * extra export endpoint while the route permission model is still maturing.
 * Actor and target names, and the names of channels the viewer may see,
 * are resolved here (lib/audit-log-view.ts) so moderators read "who" and
 * "where" instead of raw ids.
 */
export default async function AuditLogPage() {
  // View Audit Log, as GET /api/servers/{id}/audit-logs requires.
  const access = await requireAdminSection('audit');
  const db = getDb();
  const userId = access.userId;

  let entries: AuditEntryView[] = [];
  let loadError: string | null = null;
  if (userId) {
    try {
      const firstServer = access.server;
      if (firstServer) {
        entries = await loadAuditEntries(db, {
          serverId: firstServer.id,
          ownerUserId: firstServer.ownerUserId,
          viewerUserId: userId,
          limit: 100,
        });
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <AuditClient entries={entries} loadError={loadError} />
    </SettingsShell>
  );
}
