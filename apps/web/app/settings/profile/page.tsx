import { cookies } from 'next/headers';
import { getUserById, getUserImages, listServerNicknamesForUser } from '@lobbyforge/db';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { getActiveSession } from '@/lib/active-session';
import SettingsShell from '@/app/SettingsShell';
import { getTranslator } from '@/lib/i18n/server';
import ProfileBody from './ProfileBody';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata() {
  const t = await getTranslator();
  return { title: t('settings.profile.metaTitle') };
}

export default async function ProfileSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ server?: string | string[] }>;
} = {}) {
  const cookieStore = await cookies();
  const session = await getActiveSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? null;
  const db = getDb();
  // security-review FILE-001: getUserById no longer carries the image
  // columns; this page previews and re-crops the owner's OWN avatar and
  // banner, so it reads them explicitly.
  const [row, images] = userId
    ? await Promise.all([getUserById(db, userId), getUserImages(db, userId)])
    : [null, null];
  const user = row ? { ...row, avatarUrl: images?.avatarUrl ?? null, bannerUrl: images?.bannerUrl ?? null } : null;
  // Every community's nickname; the picker starts on the one the lobby
  // showed (`?server=`, from the profile card's "Edit profile").
  const communities = userId ? await listServerNicknamesForUser(db, userId) : [];
  const requested = (await searchParams)?.server;
  const requestedId = typeof requested === 'string' ? requested : null;
  const initialServerId = communities.find((c) => c.serverId === requestedId)?.serverId ?? communities[0]?.serverId ?? null;

  return (
    <SettingsShell scope="user">
      <ProfileBody user={user} communities={communities} initialServerId={initialServerId} />
    </SettingsShell>
  );
}
