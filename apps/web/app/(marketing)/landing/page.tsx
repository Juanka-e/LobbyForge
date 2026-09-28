import { Fragment } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { playerRange } from '@/lib/hub-format';
import type { LocaleInfo, Translator } from '@/lib/i18n/core';
import { getRequestI18n, getTranslator } from '@/lib/i18n/server';
import { getPlugin } from '@/lib/plugin-registry';
import ActivityMark from '../_components/ActivityMark';
import tones from '../_components/hub-tones.module.css';
import { ArrowRightIcon, BranchIcon } from '../_components/icons';
import StarOnGitHub from '../_components/StarOnGitHub';
import { buttonOutline, buttonPrimary, container, eyebrow, focusRing } from '../_components/styles';
import CommunityPreview from './CommunityPreview';
import LiveRoomMockup from './LiveRoomMockup';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return {
    title: t('hub.landing.meta.title'),
    description: t('hub.landing.hero.body'),
  };
}

/** The official activities, in the design's order. Names are brand words. */
const SHOWCASE = [
  { id: 'hushle', name: 'Hushle', copy: 'hub.landing.activities.hushle' },
  { id: 'quiz', name: 'Quiz', copy: 'hub.landing.activities.quiz' },
  { id: 'vampire-village', name: 'Vampire Village', copy: 'hub.landing.activities.vampireVillage' },
  { id: 'watch-party', name: 'Watch Party', copy: 'hub.landing.activities.watchParty' },
  { id: 'poll', name: 'Poll', copy: 'hub.landing.activities.poll' },
  { id: 'dice-bot', name: 'Dice Bot', copy: 'hub.landing.activities.diceBot' },
] as const;

const HIGHLIGHTS = ['voice', 'activities', 'selfHosted', 'ecosystem'] as const;

export default async function LandingPage() {
  if (!isOfficialDeployment()) redirect('/lobby');
  const [t, i18n] = await Promise.all([getTranslator(), getRequestI18n()]);
  return (
    <>
      <Hero t={t} languages={i18n.locales} />
      <Highlights t={t} />
      <Activities t={t} />
      <Community t={t} />
      <HostAndSource t={t} />
      <FinalCta t={t} />
    </>
  );
}

function Hero({ t, languages }: { t: Translator; languages: LocaleInfo[] }) {
  return (
    <section
      className={`${container} grid items-center gap-10 pb-14 pt-11 sm:pt-16 lg:grid-cols-2 lg:gap-16 lg:pb-24 lg:pt-[104px]`}
    >
      <div className="flex flex-col gap-5 sm:gap-7">
        <p className={`${eyebrow} text-ember`}>
          <span className="sm:hidden">{t('hub.landing.hero.eyebrowShort')}</span>
          <span className="hidden sm:inline">{t('hub.landing.hero.eyebrow')}</span>
        </p>
        <h1 className="font-display text-[42px] font-extrabold leading-[1.04] tracking-[-0.03em] text-text-primary sm:text-[56px] lg:text-[64px] xl:text-[76px] xl:leading-[1.02]">
          {t('hub.landing.hero.title')}
        </h1>
        <p className="max-w-[520px] text-pretty text-[17px] leading-[1.6] text-text-secondary sm:text-[19px]">
          {t('hub.landing.hero.body')}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3.5">
          <Link href="/register" className={`${buttonPrimary} h-[52px] rounded-[14px] px-[26px] text-base`}>
            {t('hub.nav.getStarted')}
          </Link>
          <a href="#self-host" className={`${buttonOutline} h-[52px] rounded-[14px] px-6 text-base`}>
            {t('hub.landing.cta.hostYourOwn')}
          </a>
          <a
            href={LOBBYFORGE_REPO.url}
            className={`hidden h-[52px] items-center gap-2 rounded-lg px-2 text-[15px] text-text-secondary transition-colors hover:text-text-primary sm:inline-flex ${focusRing}`}
          >
            {t('hub.landing.cta.viewSource')}
            <ArrowRightIcon />
          </a>
        </div>
        <ul className="hidden flex-wrap gap-x-[22px] gap-y-2 text-sm text-text-muted sm:flex">
          <li>{LOBBYFORGE_REPO.license}</li>
          <li>{t('hub.landing.hero.factDocker')}</li>
          <li>{t('hub.landing.hero.factDesktop')}</li>
          {/* Every language the hub speaks, each in its own name — adding a
              language to messages/ adds it here with no code change. */}
          <li>
            {languages.map((language, index) => (
              <Fragment key={language.code}>
                {index > 0 ? ' · ' : null}
                <span lang={language.code}>{language.name}</span>
              </Fragment>
            ))}
          </li>
        </ul>
      </div>
      <LiveRoomMockup t={t} />
    </section>
  );
}

function Highlights({ t }: { t: Translator }) {
  return (
    <section aria-label={t('hub.landing.highlights.label')} className={`${container} pb-20 lg:pb-[136px]`}>
      <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
        {HIGHLIGHTS.map((id, index) => (
          <li
            key={id}
            className="flex flex-col gap-2 rounded-[20px] border border-border-subtle/70 bg-surface/80 p-5 sm:gap-3 lg:rounded-[22px] lg:p-[26px]"
          >
            <span
              aria-hidden
              className="hidden size-10 items-center justify-center rounded-xl bg-primary/10 font-mono text-sm font-medium text-primary sm:flex"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <h2 className="text-[17px] font-semibold text-text-primary lg:text-lg">{t(`hub.landing.highlights.${id}.title`)}</h2>
            <p className="text-[15px] leading-[1.6] text-text-secondary">{t(`hub.landing.highlights.${id}.body`)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "4–12 players" / "Up to 50 players", read from the plugin's manifest. */
function playersLabel(t: Translator, pluginId: string): string | null {
  const range = playerRange(getPlugin(pluginId)?.manifest.catalog?.playerConfig);
  if (!range) return null;
  return range.kind === 'range'
    ? t('hub.marketplace.playerRange', { min: range.min, max: range.max })
    : t('hub.landing.activities.upTo', { max: range.max });
}

function Activities({ t }: { t: Translator }) {
  return (
    <section id="activities" aria-labelledby="hub-activities-title" className={`${container} pb-20 lg:pb-[136px]`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div className="flex max-w-[720px] flex-col gap-3.5">
          <p className={`${eyebrow} text-ember`}>{t('hub.landing.activities.eyebrow')}</p>
          <h2
            id="hub-activities-title"
            className="text-balance font-display text-[32px] font-bold leading-[1.1] tracking-[-0.02em] text-text-primary sm:text-[40px] lg:text-[50px] lg:leading-[1.08]"
          >
            {t('hub.landing.activities.title')}
          </h2>
          <p className="hidden max-w-[620px] text-pretty text-lg leading-[1.6] text-text-secondary sm:block">
            {t('hub.landing.activities.body')}
          </p>
        </div>
        <Link
          href="/marketplace"
          className={`${buttonOutline} hidden h-12 shrink-0 rounded-[14px] px-5 text-[15px] lg:inline-flex`}
        >
          {t('hub.landing.activities.browse')}
        </Link>
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:mt-8 lg:mt-10 lg:grid-cols-3 lg:gap-5">
        {SHOWCASE.map((activity) => {
          const players = playersLabel(t, activity.id);
          const id = `hub-activity-${activity.id}`;
          // Named by the activity, described by its players and blurb — the
          // player pill comes first on screen but should not be heard first.
          return (
            <li key={activity.id}>
              <Link
                href="/marketplace"
                aria-labelledby={`${id}-name`}
                aria-describedby={players ? `${id}-players ${id}-body` : `${id}-body`}
                className={`flex h-full flex-col gap-2.5 rounded-[18px] border border-border-subtle/70 bg-surface p-4 transition-colors hover:border-border-strong sm:gap-4 sm:rounded-[22px] sm:p-6 ${focusRing}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <ActivityMark
                    pluginId={activity.id}
                    name={activity.name}
                    className="sm:size-12 sm:rounded-[14px] sm:text-[22px]"
                  />
                  {players ? (
                    <span
                      id={`${id}-players`}
                      className="hidden h-[26px] items-center rounded-full bg-surface-raised px-2.5 text-xs text-text-secondary sm:inline-flex"
                    >
                      {players}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-col gap-1 sm:gap-1.5">
                  <span id={`${id}-name`} className="text-[15px] font-semibold text-text-primary sm:text-[19px]">
                    {activity.name}
                  </span>
                  {players ? (
                    <span aria-hidden className="text-xs text-text-muted sm:hidden">
                      {players}
                    </span>
                  ) : null}
                  <span id={`${id}-body`} className="hidden text-[15px] leading-[1.55] text-text-secondary sm:block">
                    {t(activity.copy)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Link href="/marketplace" className={`${buttonOutline} mt-4 h-12 w-full rounded-[14px] px-5 text-[15px] lg:hidden`}>
        {t('hub.landing.activities.browse')}
      </Link>
    </section>
  );
}

function Community({ t }: { t: Translator }) {
  // A still of the whole app needs the width of one: tablets and up.
  return (
    <section aria-labelledby="hub-community-title" className={`${container} hidden pb-[136px] md:block`}>
      <div className="mb-9 flex max-w-[720px] flex-col gap-3.5">
        <p className={`${eyebrow} text-primary`}>{t('hub.landing.preview.eyebrow')}</p>
        <h2
          id="hub-community-title"
          className="text-balance font-display text-[40px] font-bold leading-[1.08] tracking-[-0.02em] text-text-primary lg:text-[50px]"
        >
          {t('hub.landing.preview.title')}
        </h2>
      </div>
      <CommunityPreview t={t} />
    </section>
  );
}

function HostAndSource({ t }: { t: Translator }) {
  const card =
    'flex flex-col gap-5 rounded-[24px] border border-border-subtle/70 bg-background p-6 sm:gap-[22px] sm:rounded-[28px] sm:p-10';
  const heading = 'font-display text-[32px] font-bold leading-[1.1] tracking-[-0.02em] text-text-primary sm:text-[40px]';
  const chips = [
    { href: LOBBYFORGE_REPO.pluginSdkUrl, label: t('hub.footer.pluginSdk') },
    { href: LOBBYFORGE_REPO.botSdkUrl, label: t('hub.landing.openSource.botSdk') },
    { href: LOBBYFORGE_REPO.translatingUrl, label: t('hub.landing.openSource.translations') },
  ];
  return (
    <section id="self-host" className={`${container} grid scroll-mt-24 gap-6 pb-20 lg:grid-cols-2 lg:pb-[136px]`}>
      <div className={card}>
        <p className={`${eyebrow} text-ember`}>{t('hub.landing.selfHost.eyebrow')}</p>
        <h2 className={heading}>{t('hub.landing.selfHost.title')}</h2>
        <p className="hidden text-base leading-[1.6] text-text-secondary sm:block">{t('hub.landing.selfHost.body')}</p>
        <div
          role="group"
          aria-label={t('hub.landing.selfHost.commandsLabel')}
          className="rounded-2xl border border-border-subtle/70 bg-[color:var(--lf-page-bg)] p-4 font-mono text-xs leading-[1.9] text-text-primary sm:p-5 sm:text-sm"
        >
          <p className="break-words">
            <span aria-hidden className="select-none text-text-muted">$ </span>
            git clone --branch &lt;release-tag&gt; {LOBBYFORGE_REPO.cloneUrl}
          </p>
          <p>
            <span aria-hidden className="select-none text-text-muted">$ </span>
            cd LobbyForge &amp;&amp; bash install.sh
          </p>
          <p className={`hidden sm:block ${tones.success}`}>
            <span aria-hidden>✓ </span>
            {t('hub.landing.selfHost.running')}
          </p>
        </div>
        <a
          href={LOBBYFORGE_REPO.installGuideUrl}
          className={`${buttonOutline} h-11 self-stretch rounded-xl px-[18px] text-[15px] sm:self-start`}
        >
          {t('hub.landing.selfHost.guide')}
        </a>
      </div>

      <div className={card}>
        <p className={`${eyebrow} text-primary`}>{t('hub.landing.openSource.eyebrow')}</p>
        <h2 className={heading}>{t('hub.landing.openSource.title')}</h2>
        <div className="flex flex-col gap-3.5 rounded-[18px] border border-border-subtle/70 bg-surface p-5 sm:p-[22px]">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-text-primary">
              <BranchIcon size={20} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <a
                href={LOBBYFORGE_REPO.url}
                className={`truncate rounded-sm font-mono text-[15px] text-text-primary underline-offset-4 hover:underline ${focusRing}`}
              >
                {LOBBYFORGE_REPO.slug}
              </a>
              <span className="text-[13px] text-text-muted">{LOBBYFORGE_REPO.license} · TypeScript · Rust</span>
            </span>
          </div>
          <p className="text-[15px] leading-[1.6] text-text-secondary">{t('hub.landing.openSource.description')}</p>
          <div className="flex flex-wrap gap-2.5">
            <StarOnGitHub variant="primary" />
            <a
              href={LOBBYFORGE_REPO.contributingUrl}
              className={`${buttonOutline} h-11 rounded-xl px-[18px] text-[15px]`}
            >
              {t('hub.landing.openSource.contribute')}
            </a>
          </div>
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {chips.map((chip) => (
            <li key={chip.href}>
              <a
                href={chip.href}
                className={`flex h-full items-center rounded-[14px] bg-surface p-3.5 text-sm text-text-secondary transition-colors hover:text-text-primary ${focusRing}`}
              >
                {chip.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCta({ t }: { t: Translator }) {
  return (
    <section className={`${container} flex flex-col items-center gap-5 pb-24 pt-4 text-center sm:gap-7 lg:pb-[140px] lg:pt-10`}>
      <h2 className="max-w-[880px] text-balance font-display text-[38px] font-extrabold leading-[1.05] tracking-[-0.03em] text-text-primary sm:text-[52px] lg:text-[64px] lg:leading-[1.04]">
        {t('hub.landing.final.title')}
      </h2>
      <p className="hidden text-[19px] text-text-secondary sm:block">{t('hub.landing.final.body')}</p>
      <div className="flex w-full flex-col gap-3.5 sm:w-auto sm:flex-row">
        <Link href="/register" className={`${buttonPrimary} h-[52px] rounded-[14px] px-7 text-base`}>
          {t('hub.landing.final.createAccount')}
        </Link>
        <Link href="/discover" className={`${buttonOutline} hidden h-[52px] rounded-[14px] px-6 text-base sm:inline-flex`}>
          {t('hub.landing.final.explore')}
        </Link>
      </div>
    </section>
  );
}
