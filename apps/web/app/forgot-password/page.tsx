import type { Metadata } from 'next';
import AuthFlowFrame from '@/app/login/AuthFlowFrame';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import ForgotPasswordForm from './ForgotPasswordForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('emailVerification.forgot.metaTitle'),
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

/** `/forgot-password` — ask for a reset email (EMAIL.md §4.3). */
export default async function ForgotPasswordPage() {
  return (
    <AuthFlowFrame>
      <ForgotPasswordForm official={isOfficialDeployment()} />
    </AuthFlowFrame>
  );
}
