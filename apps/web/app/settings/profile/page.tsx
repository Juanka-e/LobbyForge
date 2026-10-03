import { cookies } from 'next/headers';
import { getServerMember, getUserById, getUserImages, listServersForUser } from '@lobbyforge/db';
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

export default async function ProfileSettingsPage() {
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
  const servers = userId ? await listServersForUser(db, userId, { limit: 1 }) : [];
  const server = servers[0] ?? null;
  const membership = userId && server ? await getServerMember(db, server.id, userId) : null;

  return (
    <SettingsShell scope="user">
      <ProfileBody
        user={user}
        serverProfile={server ? { serverName: server.name, nickname: membership?.nickname ?? null } : null}
      />
    </SettingsShell>
  );
}

