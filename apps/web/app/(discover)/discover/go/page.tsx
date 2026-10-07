import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getRegistryInstanceByInstanceId, isRegistryInstancePubliclyVisible } from '@lobbyforge/db';
import { buttonOutline, buttonPrimary, container, textLink } from '@/app/(marketing)/_components/styles';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getTranslator } from '@/lib/i18n/server';
import { initialOf } from '@/lib/initial';
import { rich } from '@/lib/i18n/rich';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /discover/go?id=<instanceId> — external-redirect interceptor.
 *
 * Shows a warning before navigating to a third-party LobbyForge instance.
 * The user's official-instance session/cookie does NOT cross over
 * (SameSite=Lax guarantees this). The destination creates its own guest
 * session if the visitor isn't already authenticated there.
 *
 * This page exists so that:
 * 1. The user explicitly confirms they're leaving the official host.
 * 2. Browsers show the target URL (no sneaky redirects).
 * 3. We can check isVerified + isBlocked + heartbeat freshness
 *    server-side before linking.
 *
 * It lives under /discover (the static `go` segment wins over
 * `[instanceId]`), where the directory's links, robots.txt and the docs
 * have always pointed. Official hub only, like the rest of the directory.
 */

export default async function GoPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  if (!isOfficialDeployment()) redirect('/lobby');
  const params = await searchParams;
  const id = params.id;
  if (!id) redirect('/discover');
  const t = await getTranslator();

  let instance: Awaited<ReturnType<typeof getRegistryInstanceByInstanceId>> | null = null;
  try {
    instance = await getRegistryInstanceByInstanceId(getDb(), id);
  } catch {
    // ignore — render not-found
  }

  // security-review HUB-003: a stale entry (no recent heartbeat — the
  // domain may have changed hands) gets the unavailable state, never an
  // outbound link or a verified badge.
  if (!instance || !isRegistryInstancePubliclyVisible(instance)) {
    return (
      <div className={`${container} flex justify-center pb-24 pt-16 sm:pt-24`}>
        <div className="max-w-md text-center">
          <span className="material-symbols-outlined mb-3 block text-5xl text-text-muted" aria-hidden>
            block
          </span>
          <h1 className="font-display text-2xl font-bold text-text-primary">{t('pages.go.unavailableTitle')}</h1>
          <p className="mt-2 text-pretty text-sm text-text-secondary">{t('pages.go.unavailableBody')}</p>
          <Link href="/discover" className={`${textLink} mt-5 inline-block text-sm`}>
            {t('pages.go.back')}
          </Link>
        </div>
      </div>
    );
  }

  const isVerified = instance.isVerified;
  const item = 'flex items-start gap-2';
  const itemIcon = 'material-symbols-outlined mt-0.5 text-[14px]';

  return (
    <div className={`${container} flex justify-center pb-24 pt-12 sm:pt-20`}>
      <div className="w-full max-w-md">
        <div className="rounded-[22px] border border-border-subtle/70 bg-surface p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-primary/10 font-display text-lg font-bold text-primary">
              {initialOf(instance.name, { locale: t.locale })}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-base font-semibold text-text-primary">{instance.name}</h1>
                {isVerified ? (
                  <span className="material-symbols-outlined text-[16px] text-primary" title={t('pages.go.verifiedTitle')}>
                    verified
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-text-muted">{instance.region ?? t('pages.go.unknownRegion')}</p>
            </div>
          </div>

          {/* Warning box */}
          <div className="mb-5 rounded-2xl border border-ember/30 bg-ember/5 p-4">
            <p className="text-sm leading-relaxed text-text-secondary">
              {rich(t('pages.go.leaving'), { brand: <strong className="text-text-primary">LobbyForge</strong> })}
            </p>
            <p className="mt-2 break-all rounded-lg border border-border-subtle bg-background px-2.5 py-1.5 font-mono text-sm text-text-primary">
              {instance.domain}
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-text-secondary">
              <li className={item}>
                <span className={itemIcon} aria-hidden>check_circle</span>
                {t('pages.go.noSharedSession')}
              </li>
              <li className={item}>
                <span className={itemIcon} aria-hidden>check_circle</span>
                {t('pages.go.guestSession')}
              </li>
              {!isVerified ? (
                <li className={item}>
                  <span className={`${itemIcon} text-ember`} aria-hidden>warning</span>
                  <span>
                    {rich(t('pages.go.notVerified'), { notVerified: <strong>{t('pages.go.notVerifiedEmphasis')}</strong> })}
                  </span>
                </li>
              ) : null}
              <li className={item}>
                <span className={itemIcon} aria-hidden>info</span>
                {t('pages.go.notResponsible')}
              </li>
            </ul>
          </div>

          <div className="flex gap-3">
            <Link href="/discover" className={`${buttonOutline} h-11 flex-1 rounded-xl px-4 text-sm`}>
              {t('common.cancel')}
            </Link>
            <a href={instance.domain} rel="noopener noreferrer" className={`${buttonPrimary} h-11 flex-1 rounded-xl px-4 text-sm`}>
              {t('pages.go.continue')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
