import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getSessionSecret } from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';

export default async function HomePage() {
  if (isOfficialDeployment()) redirect('/landing');
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  redirect(session?.uid ? '/lobby' : '/login');
}
