import type { Metadata } from 'next';
import { listCardPackSummaries } from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import PluginsClient, { type CardPackView, type CardView } from './PluginsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('plugins', 'admin.plugins.metaTitle');
}

/** Word packs are instance-wide: `/api/admin/card-packs` is instance-admin only, so is this page. */
export default async function PluginsSettingsPage() {
  const access = await requireAdminSection('plugins');

  let packs: CardPackView[] = [];
  let loadError: string | null = null;

  try {
    // V4-011: summaries only — cards load lazily per selected pack via
    // /api/admin/card-packs?packId=… (no N+1 over every card here).
    const db = getDb();
    packs = (await listCardPackSummaries(db, 'hushle')).map((pack) => ({
      id: pack.id,
      pluginId: pack.pluginId,
      slug: pack.slug,
      name: pack.name,
      language: pack.language,
      description: pack.description,
      isBuiltIn: pack.isBuiltIn,
      cardCount: pack.cardCount,
    }));
  } catch (err) {
    loadError = (err as Error).message;
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <PluginsClient initialPacks={packs} loadError={loadError} />
    </SettingsShell>
  );
}
