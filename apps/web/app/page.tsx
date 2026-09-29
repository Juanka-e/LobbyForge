import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getSessionSecret } from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { rootDestination } from '@/lib/hub-routes';

/**
 * `/` — official hub: signed in → the hub home, else the landing page.
 * Self-hosted: the lobby when signed in, else the instance's sign-in.
 */
export default async function HomePage() {
  const cookieStore = await cookies();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  redirect(rootDestination({ official: isOfficialDeployment(), signedIn: Boolean(session?.uid) }));
}
