/**
 * The LobbyForge repository as the official hub links to it, and its live
 * star count for the "Star on GitHub" buttons.
 *
 * The count comes from GitHub's public API, cached by Next's data cache
 * for an hour (so the hub makes about one API call an hour, well inside
 * the anonymous rate limit), with a short timeout so a slow or failing
 * GitHub never holds up a page. Every failure — timeout, rate limit,
 * unexpected payload — returns `null`, and the buttons render without a
 * count. Never an invented number.
 */
import { cache } from 'react';

const OWNER = 'Juanka-e';
const NAME = 'LobbyForge';
const WEB = `https://github.com/${OWNER}/${NAME}`;
const BLOB = `${WEB}/blob/main`;

export const LOBBYFORGE_REPO = {
  slug: `${OWNER}/${NAME}`,
  url: WEB,
  apiUrl: `https://api.github.com/repos/${OWNER}/${NAME}`,
  cloneUrl: `${WEB}.git`,
  license: 'AGPL-3.0',
  docsUrl: `${WEB}/tree/main/docs`,
  pluginSdkUrl: `${BLOB}/docs/PLUGIN_SDK.md`,
  pluginPublishingUrl: `${BLOB}/docs/PLUGIN_PUBLISHING.md`,
  botSdkUrl: `${WEB}/tree/main/packages/bot-sdk`,
  translatingUrl: `${BLOB}/docs/TRANSLATING.md`,
  installGuideUrl: `${BLOB}/docs/BETA_RELEASE.md#beta-deployment`,
  securityUrl: `${BLOB}/SECURITY.md`,
  contributingUrl: `${BLOB}/CONTRIBUTING.md`,
  licenseUrl: `${BLOB}/LICENSE`,
  codeOfConductUrl: `${BLOB}/CODE_OF_CONDUCT.md`,
} as const;

/** How long the data cache keeps a star count, in seconds. */
export const REPO_STATS_REVALIDATE_SECONDS = 3600;
/** How long a page waits for GitHub before rendering without a count. */
export const REPO_STATS_TIMEOUT_MS = 1500;

export interface RepoStats {
  stars: number;
}

/** The fields the hub reads from a GitHub `GET /repos/{owner}/{repo}` body. */
export function parseRepoStats(body: unknown): RepoStats | null {
  if (!body || typeof body !== 'object') return null;
  const stars = (body as { stargazers_count?: unknown }).stargazers_count;
  if (typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0) return null;
  return { stars };
}

export async function fetchRepoStats(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RepoStats | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(LOBBYFORGE_REPO.apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'LobbyForge-hub',
      },
      next: { revalidate: REPO_STATS_REVALIDATE_SECONDS },
      // A signal opts out of per-render deduplication only; the data
      // cache still applies — `getRepoStats` dedupes within a request.
      signal: AbortSignal.timeout(options.timeoutMs ?? REPO_STATS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseRepoStats(await response.json());
  } catch {
    return null;
  }
}

/** One lookup per request, however many buttons on the page ask for it. */
export const getRepoStats = cache(() => fetchRepoStats());

/** "1.2K" / "1,2 B" — short enough for a button badge, in the reader's language. */
export function formatStarCount(stars: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(stars);
}
