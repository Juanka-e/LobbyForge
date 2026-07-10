import { cookies } from 'next/headers';
import { getServerMember, getUserById, listServersForUser } from '@lobbyforge/db';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import ProfileBody from './ProfileBody';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Profile - User Settings',
};

export default async function ProfileSettingsPage() {
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? null;
  const db = getDb();
  const user = userId ? await getUserById(db, userId) : null;
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

