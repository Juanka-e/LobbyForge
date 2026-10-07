import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getRegistryInstanceByInstanceId,
  HEARTBEAT_STALE_MS,
  isRegistryInstancePubliclyVisible,
} from '@lobbyforge/db';
import { buttonOutline, buttonPrimary, focusRing } from '@/app/(marketing)/_components/styles';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getDb } from '@/lib/db';
import type { Translator } from '@/lib/i18n/core';
import { initialOf } from '@/lib/initial';
import { getTranslator } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /discover/[instanceId] — instance detail. People see who a community is
 * BEFORE being sent to an unknown domain: identity, live stats, policies
 * and trust signals (verified, heartbeat freshness, version). BROWSER
 * exits go through /discover/go (the external-redirect interceptor) —
 * never a bare external link; native desktop launches use the protected
 * lobbyforge:// deep-link flow instead.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<Metadata> {
  const { instanceId } = await params;
  const t = await getTranslator();
  return { title: t('pages.discoverInstance.metaTitle', { id: instanceId }) };
}

function heartbeatLabel(at: Date | null, t: Translator): { text: string; live: boolean } {
  if (!at) return { text: t('pages.discoverInstance.heartbeat.none'), live: false };
  const ageMs = Date.now() - new Date(at).getTime();
  if (ageMs < 0) return { text: t('pages.discoverInstance.heartbeat.justNow'), live: true };
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return { text: t('pages.discoverInstance.heartbeat.live'), live: true };
  if (minutes < 60) {
    return {
      text: t('pages.discoverInstance.heartbeat.minutes', { count: minutes }),
      live: minutes * 60_000 < HEARTBEAT_STALE_MS,
    };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: t('pages.discoverInstance.heartbeat.hours', { count: hours }), live: false };
  const days = Math.floor(hours / 24);
  return { text: t('pages.discoverInstance.heartbeat.days', { count: days }), live: false };
}

export default async function InstanceDetailPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  if (!isOfficialDeployment()) redirect('/lobby');
  const { instanceId } = await params;

  let instance: Awaited<ReturnType<typeof getRegistryInstanceByInstanceId>> = null;
  try {
    instance = await getRegistryInstanceByInstanceId(getDb(), instanceId);
  } catch {
    // fall through to not-found
  }
  // security-review HUB-003: the listing's freshness rule applies here too.
  // A stale entry's operator may be gone and its domain re-registered by
  // someone else — no verified badge, no way out to it, just not found.
  if (!instance || !isRegistryInstancePubliclyVisible(instance)) notFound();

  const t = await getTranslator();
  const heartbeat = heartbeatLabel(instance.lastHeartbeatAt ?? null, t);
  const go = `/discover/go?id=${encodeURIComponent(instance.instanceId)}`;

  return (
    // A detail page reads better narrower than the hub's 1240 px grid.
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-5 pb-24 pt-10 sm:px-8 sm:pt-12 lg:px-0">
      <Link
        href="/discover"
        className={`inline-flex items-center gap-1.5 self-start rounded-md text-sm text-text-secondary transition-colors hover:text-text-primary ${focusRing}`}
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden>
          arrow_back
        </span>
        {t('pages.discoverInstance.back')}
      </Link>

      {/* Identity */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex size-20 shrink-0 items-center justify-center rounded-[22px] bg-primary/10 font-display text-3xl font-bold text-primary">
          {initialOf(instance.name, { locale: t.locale })}
        </div>
        <div className="min-w-0 flex-grow">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-display text-[34px] font-bold leading-tight tracking-[-0.02em] text-text-primary sm:text-[42px]">
              {instance.name}
            </h1>
            {instance.isVerified ? (
              <span className="flex items-center gap-1 text-sm text-primary" title={t('pages.discoverInstance.domainVerified')}>
                <span className="material-symbols-outlined text-[18px]" aria-hidden>verified</span>
                {t('pages.discoverInstance.verified')}
              </span>
            ) : (
              <span className="text-sm text-text-muted">{t('pages.discoverInstance.notVerified')}</span>
            )}
          </div>
          <p className="mb-3 break-all font-mono text-sm text-text-muted">{instance.domain}</p>
          {instance.description ? (
            <p className="text-pretty leading-relaxed text-text-secondary">{instance.description}</p>
          ) : null}
        </div>
      </div>

      {/* CTAs — the exit ALWAYS goes through the interceptor */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-3.5">
          <Link href={go} className={`${buttonPrimary} h-[52px] rounded-[14px] px-7 text-base`}>
            {t('pages.discoverInstance.openBrowser')}
          </Link>
          <a
            href={`lobbyforge://connect?host=${encodeURIComponent(instance.domain)}`}
            className={`${buttonOutline} h-[52px] rounded-[14px] px-6 text-base`}
          >
            {t('pages.discoverInstance.openDesktop')}
          </a>
        </div>
        <p className="text-pretty text-sm text-text-muted">{t('pages.discoverInstance.signInNote')}</p>
      </div>

      {/* Live stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          icon={<span className={`size-2 rounded-full ${heartbeat.live ? 'bg-ember' : 'bg-text-muted'}`} />}
          value={String(instance.onlineUsers ?? 0)}
          label={t('pages.discoverInstance.stat.online')}
        />
        <Stat
          icon={<span className="material-symbols-outlined text-[16px]" aria-hidden>forum</span>}
          value={String(instance.publicRoomsCount ?? 0)}
          label={t('pages.discoverInstance.stat.rooms')}
        />
        <Stat
          icon={<span className="material-symbols-outlined text-[16px]" aria-hidden>monitor_heart</span>}
          value={instance.doctorScore != null ? String(instance.doctorScore) : '—'}
          label={t('pages.discoverInstance.stat.doctor')}
        />
        <Stat
          icon={<span className="material-symbols-outlined text-[16px]" aria-hidden>schedule</span>}
          value={heartbeat.text}
          label={t('pages.discoverInstance.stat.heartbeat')}
        />
      </div>

      {/* Facts */}
      <div className="flex flex-col gap-4 border-t border-border-subtle/70 pt-8">
        {instance.region ? (
          <Fact icon="location_on" label={t('pages.discoverInstance.fact.region')} value={instance.region} />
        ) : null}
        {(instance.languages as string[])?.length > 0 ? (
          <Fact icon="translate" label={t('pages.discoverInstance.fact.languages')} value={(instance.languages as string[]).join(', ')} />
        ) : null}
        {(instance.tags as string[])?.length > 0 ? (
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-[18px] text-text-muted" aria-hidden>sell</span>
            <div className="flex flex-wrap gap-1.5">
              {(instance.tags as string[]).map((tag) => (
                <span key={tag} className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs text-text-secondary">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {instance.version ? (
          <Fact icon="deployed_code" label={t('pages.discoverInstance.fact.version')} value={instance.version} />
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[18px] border border-border-subtle/70 bg-surface p-4">
      <span className="flex items-center gap-1.5 text-xs text-text-muted">{icon} {label}</span>
      <span className="text-xl font-semibold text-text-primary">{value}</span>
    </div>
  );
}

function Fact({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden>{icon}</span>
      <span className="w-32 shrink-0 text-xs text-text-muted">{label}</span>
      <span className="text-sm text-text-secondary">{value}</span>
    </div>
  );
}
