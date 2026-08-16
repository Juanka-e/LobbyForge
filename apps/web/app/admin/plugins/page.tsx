import { cookies } from 'next/headers';
import { listCardPackSummaries } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import PluginsClient, { type CardPackView, type CardView } from './PluginsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Plugins - Community Settings',
};

export default async function PluginsSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Plugins</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

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
    <SettingsShell scope="community">
      <PluginsClient initialPacks={packs} loadError={loadError} />
    </SettingsShell>
  );
}
