import Link from 'next/link';
import { LOBBYFORGE_REPO, formatStarCount, getRepoStats } from '@/lib/github-repo';
import type { HubViewer } from '@/lib/hub-viewer';
import { getTranslator } from '@/lib/i18n/server';
import AccountMenu from './AccountMenu';
import { HubLogo } from './HubLogo';
import HubMobileMenu from './HubMobileMenu';
import HubNavLinks, { type HubNavLink } from './HubNavLinks';
import StarOnGitHub from './StarOnGitHub';
import { buttonPrimary, focusRing } from './styles';

/**
 * The hub header, in its two designed states:
 *
 * - signed out (landing): logo · Communities, Marketplace, Download,
 *   Developers · Star on GitHub, Sign in, Get started;
 * - signed in (hub home): logo, Home, Communities, Marketplace, Download,
 *   Developers · the account menu.
 *
 * "Developers" is the hub's own docs section (`/developers`), which took
 * the place of the design's "Docs" link to the repository's docs folder —
 * that folder is linked from the section's overview.
 *
 * Below `lg` the page links move into the menu button's panel; Star on
 * GitHub joins them below `xl`, where it no longer fits the row.
 */
export default async function HubNav({ viewer }: { viewer: HubViewer | null }) {
  const t = await getTranslator();
  const signedIn = viewer !== null;
  const label = t('hub.nav.label');
  const links: HubNavLink[] = signedIn
    ? [
        { kind: 'internal', href: '/home', label: t('hub.nav.home') },
        { kind: 'internal', href: '/discover', label: t('hub.nav.communities') },
        { kind: 'internal', href: '/marketplace', label: t('hub.nav.marketplace') },
        { kind: 'internal', href: '/download', label: t('hub.nav.download') },
        { kind: 'internal', href: '/developers', label: t('hub.nav.developers') },
      ]
    : [
        { kind: 'internal', href: '/discover', label: t('hub.nav.communities') },
        { kind: 'internal', href: '/marketplace', label: t('hub.nav.marketplace') },
        { kind: 'internal', href: '/download', label: t('hub.nav.download') },
        { kind: 'internal', href: '/developers', label: t('hub.nav.developers') },
      ];
  const stats = signedIn ? null : await getRepoStats();

  return (
    <header className="sticky top-0 z-40 border-b border-border-subtle/60 bg-background/80 backdrop-blur-md">
      <a
        href="#hub-content"
        className={`sr-only rounded-lg bg-surface px-4 py-2 text-sm text-text-primary focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 ${focusRing}`}
      >
        {t('hub.nav.skip')}
      </a>
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-5 sm:px-8 lg:h-[76px] xl:px-16">
        <div className="flex min-w-0 items-center gap-10">
          <HubLogo href={signedIn ? '/home' : '/landing'} />
          {signedIn ? <HubNavLinks links={links} label={label} variant="pill" className="hidden lg:block" /> : null}
        </div>
        {signedIn ? null : <HubNavLinks links={links} label={label} variant="plain" className="hidden lg:block" />}
        <div className="flex items-center gap-2 lg:gap-3">
          {signedIn ? (
            <AccountMenu name={viewer.name} />
          ) : (
            <>
              <StarOnGitHub variant="nav" className="hidden xl:inline-flex" />
              <Link
                href="/login"
                className={`flex h-11 items-center rounded-xl px-3 text-[15px] font-medium text-text-primary transition-colors hover:bg-surface-raised lg:px-4 ${focusRing}`}
              >
                {t('hub.nav.signIn')}
              </Link>
              <Link href="/register" className={`${buttonPrimary} hidden h-11 rounded-xl px-5 text-[15px] lg:inline-flex`}>
                {t('hub.nav.getStarted')}
              </Link>
            </>
          )}
          <div className="lg:hidden">
            <HubMobileMenu
              links={links}
              label={label}
              signedIn={signedIn}
              repoUrl={LOBBYFORGE_REPO.url}
              starLabel={{
                text: t('hub.nav.star'),
                count: stats ? formatStarCount(stats.stars, t.locale) : null,
                countLabel: stats ? t('hub.nav.starCount', { count: stats.stars }) : null,
              }}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
