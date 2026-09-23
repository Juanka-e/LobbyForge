import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getTranslator } from '@/lib/i18n/server';
import SettingsShell from '@/app/SettingsShell';
import ModerationClient from './ModerationClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('admin.moderation.metaTitle') };
}

export default async function ModerationPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    const t = await getTranslator();
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('admin.moderation.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }
  return (
    <SettingsShell scope="community">
      <ModerationClient />
    </SettingsShell>
  );
}
