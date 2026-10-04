/**
 * The Developers section: which repository documents have a page, what
 * the section calls them, and how their links and anchors resolve.
 *
 * The Markdown itself comes from `docs.generated.ts` (built from `docs/`
 * by `scripts/generate-developer-docs.mjs`), so nothing here touches the
 * file system — the pages work the same from a dev checkout, a Docker
 * image or any other build.
 */
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { resolveDocLink, type DocLinkContext, type ResolvedLink } from '@/lib/markdown/links';
import { parseMarkdown, type MarkdownDocument } from '@/lib/markdown/parse';
import { DEVELOPER_DOCS, DEVELOPER_DOC_SLUGS, type DeveloperDocSlug } from './docs.generated';

export { DEVELOPER_DOC_SLUGS, type DeveloperDocSlug };

export const DEVELOPERS_PATH = '/developers';

export type DeveloperNavGroup = 'guides' | 'bots' | 'plugins';

/** The id of a navigation group's label (the group's list is labelled by it). */
export function developerNavGroupId(group: DeveloperNavGroup): string {
  return `developers-nav-${group}`;
}

/**
 * Element ids the developer pages (and the hub chrome around them) use. A
 * document heading never takes one, so its anchor cannot hijack them.
 */
export const DEVELOPER_PAGE_IDS: readonly string[] = [
  'hub-content',
  'developers-content',
  'developer-doc',
  ...(['guides', 'bots', 'plugins'] as const).map(developerNavGroupId),
];

interface DocMeta {
  group: DeveloperNavGroup;
  /** Short name in the section's navigation and the page title. */
  titleKey: string;
  /** One sentence for the overview and the page's meta description. */
  summaryKey: string;
}

const META: Record<DeveloperDocSlug, DocMeta> = {
  extending: {
    group: 'guides',
    titleKey: 'developers.docs.extending.title',
    summaryKey: 'developers.docs.extending.summary',
  },
  bots: {
    group: 'bots',
    titleKey: 'developers.docs.bots.title',
    summaryKey: 'developers.docs.bots.summary',
  },
  'bot-api-v2': {
    group: 'bots',
    titleKey: 'developers.docs.botApiV2.title',
    summaryKey: 'developers.docs.botApiV2.summary',
  },
  plugins: {
    group: 'plugins',
    titleKey: 'developers.docs.plugins.title',
    summaryKey: 'developers.docs.plugins.summary',
  },
  publishing: {
    group: 'plugins',
    titleKey: 'developers.docs.publishing.title',
    summaryKey: 'developers.docs.publishing.summary',
  },
};

/** The section navigation, in order. Every document is in exactly one group. */
export const DEVELOPER_NAV_GROUPS: ReadonlyArray<{ id: DeveloperNavGroup; labelKey: string; slugs: DeveloperDocSlug[] }> = [
  { id: 'guides', labelKey: 'developers.nav.group.guides', slugs: DEVELOPER_DOC_SLUGS.filter((s) => META[s].group === 'guides') },
  { id: 'bots', labelKey: 'developers.nav.group.bots', slugs: DEVELOPER_DOC_SLUGS.filter((s) => META[s].group === 'bots') },
  { id: 'plugins', labelKey: 'developers.nav.group.plugins', slugs: DEVELOPER_DOC_SLUGS.filter((s) => META[s].group === 'plugins') },
];

export interface DeveloperDoc extends DocMeta {
  slug: DeveloperDocSlug;
  /** The file in the repository (`docs/BOTS.md`). */
  path: string;
  markdown: string;
  /** This page's address. */
  href: string;
  /** The file in GitHub's editor. */
  editUrl: string;
}

export function isDeveloperDocSlug(value: string): value is DeveloperDocSlug {
  return (DEVELOPER_DOC_SLUGS as readonly string[]).includes(value);
}

export function developerDocHref(slug: DeveloperDocSlug): string {
  return `${DEVELOPERS_PATH}/${slug}`;
}

export function getDeveloperDoc(slug: string): DeveloperDoc | null {
  if (!isDeveloperDocSlug(slug)) return null;
  const { path, markdown } = DEVELOPER_DOCS[slug];
  return {
    slug,
    path,
    markdown,
    ...META[slug],
    href: developerDocHref(slug),
    editUrl: `${LOBBYFORGE_REPO.url}/edit/main/${path}`,
  };
}

export function listDeveloperDocs(): DeveloperDoc[] {
  return DEVELOPER_DOC_SLUGS.map((slug) => getDeveloperDoc(slug)!);
}

/** Repository file → its page here: what a relative `*.md` link is rewritten to. */
const PAGES: Readonly<Record<string, string>> = Object.fromEntries(
  DEVELOPER_DOC_SLUGS.map((slug) => [DEVELOPER_DOCS[slug].path, developerDocHref(slug)])
);

export function developerDocLinkContext(slug: DeveloperDocSlug): DocLinkContext {
  return { sourcePath: DEVELOPER_DOCS[slug].path, pages: PAGES, repoUrl: LOBBYFORGE_REPO.url, branch: 'main' };
}

/** Where a link written in `slug`'s document goes on the site (null: render it as text). */
export function resolveDeveloperDocLink(slug: DeveloperDocSlug, href: string): ResolvedLink | null {
  return resolveDocLink(href, developerDocLinkContext(slug));
}

// The Markdown never changes while the process runs, so each document is
// parsed once.
const parsed = new Map<DeveloperDocSlug, MarkdownDocument>();

export function parsedDeveloperDoc(slug: DeveloperDocSlug): MarkdownDocument {
  let doc = parsed.get(slug);
  if (!doc) {
    doc = parseMarkdown(DEVELOPER_DOCS[slug].markdown, { reservedIds: DEVELOPER_PAGE_IDS });
    parsed.set(slug, doc);
  }
  return doc;
}
