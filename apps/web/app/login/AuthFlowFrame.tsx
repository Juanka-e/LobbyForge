import type { ReactNode } from 'react';
import { getInstanceBootstrapStatus } from '@lobbyforge/db';
import { hubDisplayFont } from '@/app/(marketing)/_components/fonts';
import { HubLogo } from '@/app/(marketing)/_components/HubLogo';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';

/**
 * The frame of the account-recovery pages (`/forgot-password`,
 * `/reset-password`, `/verify-email`): the sign-in card of the deployment
 * they belong to. On the official hub, the hub's logo over a 420 px
 * column (the sign-in's form column, without its persuasion panel); on a
 * self-hosted community, the same card `/login` draws, headed by the
 * community's name.
 */
export default async function AuthFlowFrame({ children }: { children: ReactNode }) {
  if (isOfficialDeployment()) {
    return (
      <div className={`${hubDisplayFont.variable} flex min-h-dvh flex-col items-center px-5 pb-12 pt-8 sm:px-8 sm:pt-14`}>
        <div className="mb-10">
          <HubLogo href="/landing" />
        </div>
        <div className="w-full max-w-[420px]">{children}</div>
      </div>
    );
  }

  const t = await getTranslator();
  const setup = await getInstanceBootstrapStatus(getDb()).catch(() => null);
  const instanceName =
    setup?.instanceName || process.env.LOBBYFORGE_INSTANCE_NAME?.trim() || 'LobbyForge Community';
  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-background px-5 py-10 safe-area-page">
      <section className="w-full max-w-md rounded-lg border border-border-subtle bg-surface-raised p-6 shadow-lg md:p-8">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary-container font-bold text-on-primary-container">
            {instanceName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm text-text-muted">{t('auth.login.communityLabel')}</p>
            <p className="truncate text-balance text-xl font-semibold text-text-primary">{instanceName}</p>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}
