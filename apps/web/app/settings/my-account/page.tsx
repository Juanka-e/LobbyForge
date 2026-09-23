import { cookies } from 'next/headers';
import { getUserById } from '@lobbyforge/db';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import { getTranslator } from '@/lib/i18n/server';
import MyAccountBody from './MyAccountBody';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata() {
  const t = await getTranslator();
  return { title: t('settings.account.metaTitle') };
}

export default async function MyAccountPage() {
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? null;

  let user: Awaited<ReturnType<typeof getUserById>> = null;
  if (userId) {
    user = await getUserById(getDb(), userId);
  }

  return (
    <SettingsShell scope="user">
      <MyAccountBody user={user} signedIn={Boolean(userId)} />
    </SettingsShell>
  );
}

