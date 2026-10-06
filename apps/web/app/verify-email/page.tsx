import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import AuthFlowFrame from '@/app/login/AuthFlowFrame';
import { getActiveSession } from '@/lib/active-session';
import { getSessionSecret } from '@/lib/api-auth';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import { linkTokenFrom } from '@/components/email-verification/link-token';
import VerifyEmailConfirm from './VerifyEmailConfirm';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('emailVerification.link.metaTitle'),
    // The token is in this page's URL: never send it on as a Referer
    // (the response header says the same, see middleware.ts).
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

/** Only picks where "Continue" goes; a failed read just means "sign in". */
async function isSignedIn(): Promise<boolean> {
  try {
    const session = await getActiveSession((await cookies()).toString(), getSessionSecret());
    return Boolean(session?.uid);
  } catch {
    return false;
  }
}

/**
 * `/verify-email?t=…` — the link in a verification email (EMAIL.md §4.1).
 *
 * Opening it (GET) never verifies anything: mail scanners open links on
 * their own. The page only shows a button, and the button POSTs the
 * token. The link never signs anyone in either, so a signed-out browser
 * (the phone the email was read on) can use it.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const { t: raw } = await searchParams;
  const token = linkTokenFrom(raw);
  const official = isOfficialDeployment();
  const signedIn = await isSignedIn();
  return (
    <AuthFlowFrame>
      <VerifyEmailConfirm
        token={token}
        official={official}
        continueHref={signedIn ? (official ? '/home' : '/lobby') : '/login'}
        signedIn={signedIn}
      />
    </AuthFlowFrame>
  );
}
