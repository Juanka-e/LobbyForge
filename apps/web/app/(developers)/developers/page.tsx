import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { listDeveloperDocs } from '@/lib/developer-docs/registry';
import { getTranslator } from '@/lib/i18n/server';
import { buttonOutline, buttonPrimary, container, eyebrow, focusRing, textLink } from '@/app/(marketing)/_components/styles';
import { ArrowRightIcon } from '@/app/(marketing)/_components/icons';
import { BUILD_CARDS } from './_components/build-cards';
import DevelopersNav from './_components/DevelopersNav';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('developers.meta.title'), description: t('developers.meta.description') };
}

/**
 * The Developers overview: what can be built on LobbyForge, the guides,
 * and the source. The same page on the official hub and on a self-hosted
 * instance (only the frame around it differs — see `../layout.tsx`).
 */
export default async function DevelopersPage() {
  const t = await getTranslator();
  const docs = listDeveloperDocs();

  return (
    <div className={`${container} pb-20 pt-6 sm:pt-10 lg:pb-24`}>
      <div className="lg:hidden">
        <DevelopersNav t={t} current="overview" />
      </div>

      <header className="mt-8 flex max-w-[760px] flex-col gap-4 sm:mt-10 lg:mt-6">
        <p className={`${eyebrow} text-ember`}>{t('developers.overview.eyebrow')}</p>
        <h1 className="text-balance font-display text-[36px] font-bold leading-[1.08] tracking-[-0.02em] text-text-primary sm:text-[50px]">
          {t('developers.overview.title')}
        </h1>
        <p className="text-pretty text-lg leading-[1.6] text-text-secondary">{t('developers.overview.body')}</p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link href={'/developers/extending' as Route} className={`${buttonPrimary} h-12 rounded-[14px] px-6 text-[15px]`}>
            {t('developers.overview.start')}
            <ArrowRightIcon />
          </Link>
          <a href={LOBBYFORGE_REPO.url} className={`${buttonOutline} h-12 rounded-[14px] px-6 text-[15px]`}>
            {t('developers.overview.viewSource')}
          </a>
        </div>
      </header>

      <section aria-labelledby="developers-build" className="mt-16 lg:mt-20">
        <h2 id="developers-build" className="text-2xl font-semibold tracking-[-0.01em] text-text-primary sm:text-[28px]">
          {t('developers.overview.build.title')}
        </h2>
        <p className="mt-2 max-w-[680px] text-pretty text-[15px] leading-[1.6] text-text-secondary">
          {t('developers.overview.build.body')}
        </p>
        <ul className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BUILD_CARDS.map((card) => (
            <li
              key={card.id}
              className="relative flex flex-col gap-3 rounded-[22px] border border-border-subtle/70 bg-surface p-6 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between gap-3">
                <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <span className="material-symbols-outlined text-[22px]">{card.icon}</span>
                </span>
                <span className="rounded-full bg-surface-raised px-2.5 py-1 font-mono text-[11.5px] text-text-secondary">{card.tag}</span>
              </div>
              <h3 className="text-lg font-semibold text-text-primary">
                {/* The whole card is the link's hit area; its name is the title. */}
                <Link
                  href={card.href as Route}
                  className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-primary"
                >
                  {t(`developers.overview.card.${card.id}.title`)}
                </Link>
              </h3>
              <p className="text-[15px] leading-[1.6] text-text-secondary">{t(`developers.overview.card.${card.id}.body`)}</p>
              <span aria-hidden className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-medium text-primary">
                {t('developers.overview.readMore')}
                <ArrowRightIcon size={14} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-16 grid gap-6 lg:mt-20 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <section aria-labelledby="developers-guides">
          <h2 id="developers-guides" className="text-2xl font-semibold tracking-[-0.01em] text-text-primary sm:text-[28px]">
            {t('developers.overview.guides.title')}
          </h2>
          <ul className="mt-6 divide-y divide-border-subtle/70 overflow-hidden rounded-[22px] border border-border-subtle/70 bg-surface">
            {docs.map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={doc.href as Route}
                  className={`group flex items-start justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-raised sm:px-6 ${focusRing} focus-visible:outline-offset-[-2px]`}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-semibold text-text-primary">{t(doc.titleKey)}</span>
                    <span className="text-pretty text-sm leading-[1.55] text-text-secondary">{t(doc.summaryKey)}</span>
                  </span>
                  <ArrowRightIcon className="mt-1 shrink-0 text-text-muted transition-colors group-hover:text-primary" />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="developers-source"
          className="flex flex-col gap-3 self-start rounded-[22px] border border-border-subtle/70 bg-surface p-6 lg:mt-[58px]"
        >
          <h2 id="developers-source" className="text-lg font-semibold text-text-primary">
            {t('developers.overview.source.title')}
          </h2>
          <p className="text-pretty text-[15px] leading-[1.6] text-text-secondary">{t('developers.overview.source.body')}</p>
          <ul className="mt-1 flex flex-col gap-2.5 text-[15px]">
            <li>
              <a href={LOBBYFORGE_REPO.docsUrl} className={textLink}>
                {t('developers.overview.source.docsFolder')}
              </a>
            </li>
            <li>
              <a href={LOBBYFORGE_REPO.botSdkUrl} className={textLink}>
                {t('developers.overview.source.botSdk')}
              </a>
            </li>
            <li>
              <a href={LOBBYFORGE_REPO.url} className={textLink}>
                {t('developers.overview.source.repository', { repo: LOBBYFORGE_REPO.slug })}
              </a>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
