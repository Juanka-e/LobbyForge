import { cookies } from 'next/headers';
import { getEffectiveInstanceAccessSettings } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import InstanceAccessForm from './InstanceAccessForm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Authentication - Community Settings',
};

export default async function AuthenticationSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Authentication</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const settings = await getEffectiveInstanceAccessSettings(getDb());
  return (
    <SettingsShell scope="community">
      <section>
        <h1 className="text-2xl font-semibold text-text-primary">Authentication</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Control how new people enter this instance.
        </p>
        <div className="mt-6">
          <InstanceAccessForm
            initial={{
              registrationMode: settings.registrationMode,
              guestAccessEnabled: settings.guestAccessEnabled,
              seoIndexingEnabled: settings.seoIndexingEnabled,
              seoTitle: settings.seoTitle,
              seoDescription: settings.seoDescription,
            }}
          />
        </div>
      </section>
    </SettingsShell>
  );
}
