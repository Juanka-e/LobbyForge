import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { getTranslator } from '@/lib/i18n/server';
import SettingsShell from '@/app/SettingsShell';
import InstanceAccessForm from './InstanceAccessForm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.auth.metaTitle') };
}

export default async function AuthenticationSettingsPage() {
  const t = await getTranslator();
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.auth.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const [settings, bootstrap] = await Promise.all([
    getEffectiveInstanceAccessSettings(getDb()),
    getInstanceBootstrapStatus(getDb()),
  ]);
  return (
    <SettingsShell scope="community">
      <section>
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.auth.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.auth.subtitle')}</p>
        <div className="mt-6">
          <InstanceAccessForm
            initial={{
              registrationMode: settings.registrationMode,
              guestAccessEnabled: settings.guestAccessEnabled,
              seoIndexingEnabled: settings.seoIndexingEnabled,
              seoTitle: settings.seoTitle,
              seoDescription: settings.seoDescription,
            }}
            serverId={bootstrap.firstServerId}
          />
        </div>
      </section>
    </SettingsShell>
  );
}
