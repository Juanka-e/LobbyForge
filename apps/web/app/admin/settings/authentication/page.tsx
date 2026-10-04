import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { getDiscovery, readCatalogue } from '@/lib/i18n/catalogue';
import { getTranslator } from '@/lib/i18n/server';
import SettingsShell from '@/app/SettingsShell';
import BotProtectionCard from './BotProtectionCard';
import InstanceAccessForm from './InstanceAccessForm';
import type { PrivacyNoticeSet } from './PrivacyNoticeDialog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.auth.metaTitle') };
}

/**
 * The bot-protection privacy-notice paragraphs in every language that has
 * them translated — not only the admin's own: the paragraph goes into a
 * notice the community's visitors read. Each comes from that language's
 * own catalogue, so a new language brings its paragraphs with it.
 */
function privacyNotices(): PrivacyNoticeSet[] {
  return getDiscovery().locales.flatMap((locale) => {
    try {
      const { messages } = readCatalogue(locale.code);
      const altcha = messages['captcha.privacyNotice.altcha']?.trim();
      const turnstile = messages['captcha.privacyNotice.turnstile']?.trim();
      const recaptcha = messages['captcha.privacyNotice.recaptcha']?.trim();
      return altcha && turnstile && recaptcha ? [{ code: locale.code, name: locale.name, altcha, turnstile, recaptcha }] : [];
    } catch {
      return [];
    }
  });
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
        {/* Outside the access form: it saves on its own, and the form's sticky
            save bar ends with the form instead of floating over this card. */}
        <div className="mt-8 max-w-4xl">
          <BotProtectionCard notices={privacyNotices()} />
        </div>
      </section>
    </SettingsShell>
  );
}
