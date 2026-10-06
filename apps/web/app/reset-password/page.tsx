import type { Metadata } from 'next';
import AuthFlowFrame from '@/app/login/AuthFlowFrame';
import { linkTokenFrom } from '@/components/email-verification/link-token';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import ResetPasswordForm from './ResetPasswordForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('emailVerification.reset.metaTitle'),
    // The reset token is in the URL: no Referer, ever.
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

/**
 * `/reset-password?t=…` — choose a new password with the link from a
 * reset email, or (without a link, or on another device) with the email
 * address and the code from it (EMAIL.md §4.3).
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const { t: raw } = await searchParams;
  return (
    <AuthFlowFrame>
      <ResetPasswordForm token={linkTokenFrom(raw)} official={isOfficialDeployment()} />
    </AuthFlowFrame>
  );
}
