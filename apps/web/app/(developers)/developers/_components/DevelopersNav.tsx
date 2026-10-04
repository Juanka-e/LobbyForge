import type { Route } from 'next';
import Link from 'next/link';
import {
  DEVELOPERS_PATH,
  DEVELOPER_NAV_GROUPS,
  developerDocHref,
  developerNavGroupId,
  getDeveloperDoc,
  type DeveloperDocSlug,
} from '@/lib/developer-docs/registry';
import type { Translator } from '@/lib/i18n/core';
import { focusRing } from '@/app/(marketing)/_components/styles';

export type DevelopersPage = 'overview' | DeveloperDocSlug;

/**
 * The section's own navigation: the overview and every document, grouped.
 * From `lg` up it is a sidebar; below, a row of pills that scrolls
 * sideways. Both carry the same landmark name, and only one is ever
 * displayed, so assistive technology meets exactly one.
 */
export default function DevelopersNav({ t, current }: { t: Translator; current: DevelopersPage }) {
  const label = t('developers.nav.label');
  const docTitle = (slug: DeveloperDocSlug) => t(getDeveloperDoc(slug)!.titleKey);
  const allSlugs = DEVELOPER_NAV_GROUPS.flatMap((group) => group.slugs);

  const sidebarLink = (active: boolean) =>
    `block rounded-lg px-3 py-1.5 text-[14px] transition-colors ${focusRing} ${
      active ? 'bg-primary/10 font-medium text-text-primary' : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
    }`;
  const pill = (active: boolean) =>
    `flex h-9 items-center whitespace-nowrap rounded-full border px-3.5 text-[13.5px] transition-colors ${focusRing} ${
      active
        ? 'border-primary/40 bg-primary/10 font-medium text-text-primary'
        : 'border-border-subtle text-text-secondary hover:bg-surface-raised hover:text-text-primary'
    }`;

  return (
    <>
      <nav aria-label={label} className="hidden lg:block">
        <ul className="flex flex-col gap-5">
          <li>
            <Link
              href={DEVELOPERS_PATH as Route}
              aria-current={current === 'overview' ? 'page' : undefined}
              className={sidebarLink(current === 'overview')}
            >
              {t('developers.nav.overview')}
            </Link>
          </li>
          {DEVELOPER_NAV_GROUPS.map((group) => (
            <li key={group.id}>
              <p id={developerNavGroupId(group.id)} className="mb-1.5 px-3 text-[11.5px] font-medium uppercase tracking-[0.14em] text-text-muted">
                {t(group.labelKey)}
              </p>
              <ul aria-labelledby={developerNavGroupId(group.id)} className="flex flex-col gap-0.5">
                {group.slugs.map((slug) => (
                  <li key={slug}>
                    <Link
                      href={developerDocHref(slug) as Route}
                      aria-current={current === slug ? 'page' : undefined}
                      className={sidebarLink(current === slug)}
                    >
                      {docTitle(slug)}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label={label} className="-mx-5 overflow-x-auto px-5 sm:-mx-8 sm:px-8 lg:hidden">
        <ul className="flex w-max gap-2 py-1">
          <li>
            <Link
              href={DEVELOPERS_PATH as Route}
              aria-current={current === 'overview' ? 'page' : undefined}
              className={pill(current === 'overview')}
            >
              {t('developers.nav.overview')}
            </Link>
          </li>
          {allSlugs.map((slug) => (
            <li key={slug}>
              <Link href={developerDocHref(slug) as Route} aria-current={current === slug ? 'page' : undefined} className={pill(current === slug)}>
                {docTitle(slug)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
