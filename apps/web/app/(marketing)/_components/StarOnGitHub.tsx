import { LOBBYFORGE_REPO, formatStarCount, getRepoStats } from '@/lib/github-repo';
import { getTranslator } from '@/lib/i18n/server';
import { StarIcon } from './icons';
import { buttonOutline, buttonPrimary } from './styles';

/**
 * "Star on GitHub" with the repository's live star count. The count is
 * fetched server-side (cached for an hour, 1.5 s timeout — see
 * `lib/github-repo.ts`); when GitHub cannot be reached the button simply
 * has no count.
 */
export default async function StarOnGitHub({
  variant,
  className = '',
}: {
  /** `nav`: the header's small outlined button. `primary`: the open-source card's CTA. */
  variant: 'nav' | 'primary' | 'outline';
  className?: string;
}) {
  const [t, stats] = await Promise.all([getTranslator(), getRepoStats()]);
  const shape =
    variant === 'nav'
      ? `${buttonOutline} h-10 rounded-xl border-border-subtle px-3.5 text-sm`
      : variant === 'primary'
        ? `${buttonPrimary} h-11 rounded-xl px-[18px] text-[15px]`
        : `${buttonOutline} h-[52px] w-full rounded-[14px] px-6 text-base`;
  return (
    <a href={LOBBYFORGE_REPO.url} className={`${shape} ${className}`}>
      <StarIcon className={variant === 'primary' ? undefined : 'text-ember'} />
      {t('hub.nav.star')}
      {stats ? (
        <>
          <span
            aria-hidden
            className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
              variant === 'primary' ? 'bg-on-primary/15' : 'bg-surface-raised text-text-secondary'
            }`}
          >
            {formatStarCount(stats.stars, t.locale)}
          </span>
          {/* Read after the label: "Star on GitHub (1,234 stars)". */}
          <span className="sr-only"> {t('hub.nav.starCount', { count: stats.stars })}</span>
        </>
      ) : null}
    </a>
  );
}
