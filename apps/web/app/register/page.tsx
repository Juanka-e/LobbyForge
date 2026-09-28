import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionSecret } from '@/lib/api-auth';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { readGuestSession } from '@/lib/guest-session';
import { officialAuthDestination } from '@/lib/hub-routes';
import { getTranslator } from '@/lib/i18n/server';
import OfficialSignUpPage from '../login/_official/OfficialSignUpPage';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (!isOfficialDeployment()) return {};
  const t = await getTranslator();
  return { title: t('auth.official.signUp.metaTitle') };
}

/**
 * /register
 *
 * - Official hub: its own account creation page (an official account joins
 *   no community at sign-up). Someone already signed in goes to the hub home.
 * - Self-hosted instance: a deep link into the auth shell's "Create account"
 *   tab at /login (Sign in / Create account tabs, policy-aware: open /
 *   invite-only / closed), preserving an ?invite= code. All guards
 *   (bootstrap, session) run on /login itself — this is a pure redirect.
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  if (isOfficialDeployment()) {
    const session = readGuestSession((await cookies()).toString(), getSessionSecret());
    const destination = officialAuthDestination(Boolean(session?.uid));
    if (destination) redirect(destination);
    return <OfficialSignUpPage />;
  }
  const { invite } = await searchParams;
  const suffix = invite ? `&invite=${encodeURIComponent(invite)}` : '';
  redirect(`/login?mode=register${suffix}`);
}
