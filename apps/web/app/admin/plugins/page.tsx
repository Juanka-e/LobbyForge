import { cookies } from 'next/headers';
import { listCardPackSummaries, listCardsForPack } from '@lobbyforge/db';
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
    const db = getDb();
    const summaries = await listCardPackSummaries(db);
    packs = await Promise.all(
      summaries.map(async (pack): Promise<CardPackView> => {
        const cards = await listCardsForPack(db, pack.id);
        return {
          id: pack.id,
          pluginId: pack.pluginId,
          slug: pack.slug,
          name: pack.name,
          language: pack.language,
          description: pack.description,
          isBuiltIn: pack.isBuiltIn,
          cardCount: pack.cardCount,
          cards: cards.map(
            (card): CardView => ({
              id: card.id,
              word: String(card.payload.word ?? ''),
              forbiddenWords: Array.isArray(card.payload.forbiddenWords)
                ? (card.payload.forbiddenWords as unknown[])
                    .filter((w): w is string => typeof w === 'string')
                    .join(', ')
                : '',
              difficulty: card.difficulty,
              category: card.category,
              ordinal: card.ordinal,
            })
          ),
        };
      })
    );
  } catch (err) {
    loadError = (err as Error).message;
  }

  return (
    <SettingsShell scope="community">
      <PluginsClient initialPacks={packs} loadError={loadError} />
    </SettingsShell>
  );
}
