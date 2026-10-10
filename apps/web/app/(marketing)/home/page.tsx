import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listActivelyBannedServerIds, listPublicRegistryInstances, listServersForUser } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { initialsFor, tintFor } from '@/lib/hub-format';
import { hubHomeDestination } from '@/lib/hub-routes';
import { getHubViewer } from '@/lib/hub-viewer';
import type { Translator } from '@/lib/i18n/core';
import { rich } from '@/lib/i18n/rich';
import { getTranslator } from '@/lib/i18n/server';
import { pluginName, pluginSummary } from '@/lib/plugin-catalog-text';
import { listPluginSummaries } from '@/lib/plugin-registry';
import ActivityMark from '../_components/ActivityMark';
import tones from '../_components/hub-tones.module.css';
import { PlusIcon } from '../_components/icons';
import { buttonPrimary, container, focusRing, textLink } from '../_components/styles';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  // A personal page: never indexed, whatever the instance's SEO setting.
  return { title: t('hub.home.meta.title'), robots: { index: false, follow: false } };
}

/** An account this new is greeted, not welcomed back. */
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
/** Initials sit on a pastel tile in every theme, so their ink is fixed. */
const INITIAL_INK = '#07101E';

/** Directory regions the registry stores in English; shown in the reader's words. */
const REGION_KEYS: Record<string, string> = {
  Europe: 'discovery.region.europe',
  'North America': 'discovery.region.northAmerica',
  Asia: 'discovery.region.asia',
  'South America': 'discovery.region.southAmerica',
  Oceania: 'discovery.region.oceania',
  Africa: 'discovery.region.africa',
};

interface CommunityCardData {
  id: string;
  name: string;
  owned: boolean;
}

interface DirectoryCardData {
  instanceId: string;
  name: string;
  description: string | null;
  isVerified: boolean;
  languages: string[];
  region: string | null;
}

/**
 * The communities this account belongs to on this hub — the same list the
 * lobby's server rail shows, minus any community the user is banned from.
 * `null` when it cannot be read (the page says so instead of "none").
 */
async function loadCommunities(userId: string): Promise<CommunityCardData[] | null> {
  try {
    const db = getDb();
    let servers = await listServersForUser(db, userId, { limit: 50 });
    if (servers.length > 0) {
      const banned = await listActivelyBannedServerIds(db, userId, servers.map((s) => s.id));
      if (banned.size > 0) servers = servers.filter((s) => !banned.has(s.id));
    }
    return servers.map((s) => ({ id: s.id, name: s.name, owned: s.ownerUserId === userId }));
  } catch (error) {
    console.error('[hub-home] communities load failed:', (error as Error).name || 'UnknownError');
    return null;
  }
}

/**
 * A few communities from the public directory (what `/discover` lists).
 * Adult-flagged listings are left for the directory itself, where the
 * visitor chooses to browse.
 */
async function loadDirectory(): Promise<DirectoryCardData[] | null> {
  try {
    const rows = await listPublicRegistryInstances(getDb(), { limit: 12 });
    return rows
      .filter((row) => !row.nsfw)
      .slice(0, 3)
      .map((row) => ({
        instanceId: row.instanceId,
        name: row.name,
        description: row.description,
        isVerified: row.isVerified,
        languages: (row.languages as string[]) ?? [],
        region: row.region,
      }));
  } catch (error) {
    console.error('[hub-home] directory load failed:', (error as Error).name || 'UnknownError');
    return null;
  }
}

export default async function HubHomePage() {
  const viewer = await getHubViewer();
  const destination = hubHomeDestination({ official: isOfficialDeployment(), signedIn: viewer !== null });
  if (destination || !viewer) redirect(destination ?? '/login');

  const [t, communities, directory] = await Promise.all([
    getTranslator(),
    loadCommunities(viewer.userId),
    loadDirectory(),
  ]);
  const isNewAccount =
    viewer.createdAt !== null && Date.now() - viewer.createdAt.getTime() < NEW_ACCOUNT_WINDOW_MS;

  return (
    <div
      className={`${container} grid gap-10 pb-20 pt-10 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_340px] lg:pb-24 xl:grid-cols-[minmax(0,1fr)_380px]`}
    >
      <div className="flex min-w-0 flex-col gap-11">
        <header className="flex flex-col gap-2.5">
          <h1 className="text-balance font-display text-[36px] font-extrabold leading-[1.1] tracking-[-0.03em] text-text-primary sm:text-[48px]">
            {isNewAccount
              ? t('hub.home.greetingNew', { name: viewer.name })
              : t('hub.home.greeting', { name: viewer.name })}
          </h1>
          <p className="text-pretty text-[17px] text-text-secondary">{t('hub.home.subtitle')}</p>
        </header>
        <Communities t={t} communities={communities} />
        <Discover t={t} directory={directory} />
      </div>
      <div className="flex flex-col gap-4">
        <DesktopCard t={t} />
        <MarketplacePicks t={t} />
        <BuildCard t={t} />
      </div>
    </div>
  );
}

function SectionHeader({ id, title, action }: { id: string; title: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 id={id} className="text-xl font-semibold text-text-primary">
        {title}
      </h2>
      {action}
    </div>
  );
}

function Communities({ t, communities }: { t: Translator; communities: CommunityCardData[] | null }) {
  return (
    <section aria-labelledby="hub-home-communities" className="flex flex-col gap-4">
      <SectionHeader
        id="hub-home-communities"
        title={t('hub.home.communities.title')}
        action={
          <Link href="/instances/new" className={`${textLink} text-sm`}>
            {t('hub.home.communities.create')}
          </Link>
        }
      />
      {communities === null ? (
        <p className="text-[15px] text-text-secondary">{t('hub.home.communities.unavailable')}</p>
      ) : communities.length === 0 ? (
        <p className="text-pretty text-[15px] text-text-secondary">{t('hub.home.communities.empty')}</p>
      ) : null}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(communities ?? []).map((community) => (
          <li key={community.id}>
            <div className="flex h-full flex-col gap-3.5 rounded-[20px] border border-border-subtle/70 bg-surface p-5">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-[14px] text-sm font-bold"
                  style={{ backgroundColor: tintFor(community.id), color: INITIAL_INK }}
                >
                  {initialsFor(community.name, t.locale)}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h3 className="truncate text-base font-semibold text-text-primary">{community.name}</h3>
                  <p className="text-[13px] text-text-muted">
                    {community.owned ? t('hub.home.communities.owner') : t('hub.home.communities.member')}
                  </p>
                </div>
              </div>
              <a
                href={`/lobby?server=${encodeURIComponent(community.id)}`}
                aria-label={t('hub.home.communities.openLabel', { name: community.name })}
                className={`mt-auto flex h-10 items-center justify-center rounded-xl bg-surface-raised text-sm font-medium text-text-primary transition-colors hover:bg-surface-container ${focusRing}`}
              >
                {t('hub.home.communities.open')}
              </a>
            </div>
          </li>
        ))}
        <li>
          <Link
            href="/connect"
            className={`flex h-full min-h-[156px] flex-col items-center justify-center gap-2.5 rounded-[20px] border border-dashed border-border-strong p-5 text-center text-sm text-text-secondary transition-colors hover:border-primary hover:text-text-primary ${focusRing}`}
          >
            <span aria-hidden className="flex size-11 items-center justify-center rounded-full bg-surface text-primary">
              <PlusIcon size={22} />
            </span>
            {t('hub.home.communities.add')}
          </Link>
        </li>
      </ul>
    </section>
  );
}

function directoryMeta(t: Translator, card: DirectoryCardData): string | null {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([t.locale], { type: 'language' });
  } catch {
    names = null;
  }
  const languages = card.languages.slice(0, 2).map((code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code; // not a language code — show what the listing says
    }
  });
  const regionKey = card.region ? REGION_KEYS[card.region] : undefined;
  const region = regionKey ? t(regionKey) : card.region;
  const parts = [...languages, ...(region ? [region] : [])];
  return parts.length > 0 ? parts.join(' · ') : null;
}

function Discover({ t, directory }: { t: Translator; directory: DirectoryCardData[] | null }) {
  return (
    <section aria-labelledby="hub-home-discover" className="flex flex-col gap-4">
      <SectionHeader
        id="hub-home-discover"
        title={t('hub.home.discover.title')}
        action={
          <Link href="/discover" className={`${textLink} text-sm`}>
            {t('hub.home.discover.seeAll')}
          </Link>
        }
      />
      {directory === null || directory.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-[20px] border border-border-subtle/70 bg-background p-6 text-[15px] text-text-secondary">
          <p>{directory === null ? t('hub.home.discover.unavailable') : t('hub.home.discover.empty')}</p>
          <p>
            {rich(t('hub.home.discover.emptyHint'), {
              link: (
                <a href="/landing#self-host" className={textLink}>
                  {t('hub.home.discover.hostLink')}
                </a>
              ),
            })}
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {directory.map((card) => {
            const meta = directoryMeta(t, card);
            return (
              <li key={card.instanceId}>
                <a
                  href={`/discover/${encodeURIComponent(card.instanceId)}`}
                  className={`flex h-full flex-col gap-2.5 rounded-[20px] border border-border-subtle/70 bg-background p-5 transition-colors hover:border-border-strong ${focusRing}`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-base font-semibold text-text-primary">{card.name}</span>
                    {card.isVerified ? (
                      <span
                        className={`flex h-[22px] shrink-0 items-center rounded-full bg-success/10 px-2 text-[11px] font-semibold uppercase tracking-[0.04em] ${tones.success}`}
                      >
                        {t('hub.trust.verified')}
                      </span>
                    ) : null}
                  </span>
                  {card.description ? (
                    <span className="line-clamp-3 text-sm leading-[1.5] text-text-secondary">{card.description}</span>
                  ) : null}
                  {meta ? <span className="mt-auto text-xs text-text-muted">{meta}</span> : null}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const asideEyebrow = 'text-xs uppercase tracking-[0.14em]';

function DesktopCard({ t }: { t: Translator }) {
  return (
    <section
      aria-labelledby="hub-home-desktop"
      className="flex flex-col gap-3 rounded-[22px] border border-border-subtle/70 bg-surface p-6"
    >
      <p className={`${asideEyebrow} text-text-muted`}>{t('hub.home.desktop.eyebrow')}</p>
      <h2 id="hub-home-desktop" className="text-lg font-semibold text-text-primary">
        {t('hub.home.desktop.title')}
      </h2>
      <p className="text-sm leading-[1.55] text-text-secondary">{t('hub.home.desktop.body')}</p>
      <Link href="/download" className={`${buttonPrimary} h-11 rounded-xl px-4 text-[15px]`}>
        {t('hub.home.desktop.download')}
      </Link>
      <p className="text-center text-xs text-text-muted">{t('hub.home.desktop.note')}</p>
    </section>
  );
}

/** The activities that ship with LobbyForge (compiled in), in the reader's language. */
function MarketplacePicks({ t }: { t: Translator }) {
  const picks = listPluginSummaries()
    .map((plugin) => ({
      id: plugin.id,
      name: pluginName(plugin.id, t.locale, plugin.name),
      summary: pluginSummary(plugin.id, t.locale, plugin.catalog?.summary ?? null),
    }));
  return (
    <section
      aria-labelledby="hub-home-marketplace"
      className="flex flex-col gap-3.5 rounded-[22px] border border-border-subtle/70 bg-surface p-6"
    >
      <h2 id="hub-home-marketplace" className={`${asideEyebrow} font-normal text-text-muted`}>
        {t('hub.home.marketplace.eyebrow')}
      </h2>
      <ul className="flex flex-col gap-3.5">
        {picks.map((pick) => (
          <li key={pick.id} className="flex items-center gap-3">
            <ActivityMark pluginId={pick.id} name={pick.name} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold text-text-primary">{pick.name}</span>
              {pick.summary ? <span className="line-clamp-2 text-xs text-text-muted">{pick.summary}</span> : null}
            </span>
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary">
              {t('hub.trust.official')}
            </span>
          </li>
        ))}
      </ul>
      <Link href="/marketplace" className={`${textLink} self-start text-sm`}>
        {t('hub.landing.activities.browse')}
      </Link>
    </section>
  );
}

function BuildCard({ t }: { t: Translator }) {
  return (
    <section
      aria-labelledby="hub-home-build"
      className="flex flex-col gap-2.5 rounded-[22px] border border-ember/30 bg-background p-6"
    >
      <p className={`${asideEyebrow} text-ember`}>{t('hub.home.build.eyebrow')}</p>
      <h2 id="hub-home-build" className="text-base font-semibold text-text-primary">
        {t('hub.home.build.title')}
      </h2>
      <p className="text-sm leading-[1.55] text-text-secondary">{t('hub.home.build.body')}</p>
      <a href={LOBBYFORGE_REPO.pluginSdkUrl} className={`${textLink} self-start text-sm`}>
        {t('hub.home.build.link')}
      </a>
    </section>
  );
}
