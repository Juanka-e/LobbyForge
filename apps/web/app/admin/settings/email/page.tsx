import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import { offeredMailProviders } from '@/lib/mail/providers';
import SettingsShell from '@/app/SettingsShell';
import EmailSettingsCard from './EmailSettingsCard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.email.metaTitle') };
}

/**
 * Admin → Settings → Email (docs/EMAIL.md §5.1): the mail provider and its
 * connection, the sending limit and the test email, the verification mode
 * and the disposable-address block. Instance admins only, like every
 * `/api/admin` route the card talks to.
 */
export default async function EmailSettingsPage() {
  const t = await getTranslator();
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.email.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  // Mailpit (the development preset) on every instance but the official hub
  // (EMAIL.md §2.2): `localhost:19525` on a dev host, `mailpit:1025` (the
  // compose service) in a production build. The card still shows it when
  // it is the saved provider.
  const providers = offeredMailProviders({
    production: process.env.NODE_ENV === 'production',
    official: isOfficialDeployment(),
  });

  return (
    <SettingsShell scope="community">
      <section>
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.email.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.email.subtitle')}</p>
        <div className="mt-6 max-w-4xl">
          <EmailSettingsCard providers={providers} />
        </div>
      </section>
    </SettingsShell>
  );
}
