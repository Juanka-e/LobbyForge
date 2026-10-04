import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEVELOPER_DOC_SOURCES,
  GENERATED_MODULE_PATH,
  REPO_ROOT,
  buildDeveloperDocsModule,
  normalizeMarkdown,
} from '../../../scripts/generate-developer-docs.mjs';
import { DEVELOPER_DOCS, DEVELOPER_DOC_SLUGS } from '../docs.generated';
import {
  DEVELOPER_NAV_GROUPS,
  DEVELOPER_PAGE_IDS,
  getDeveloperDoc,
  parsedDeveloperDoc,
  resolveDeveloperDocLink,
  type DeveloperDocSlug,
} from '../registry';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown/parse';
import { BUILD_CARDS } from '@/app/(developers)/developers/_components/build-cards';

const REGENERATE = 'pnpm --filter @lobbyforge/web docs:generate';
const BLOB = 'https://github.com/Juanka-e/LobbyForge/blob/main/';

describe('docs.generated.ts', () => {
  it.each(DEVELOPER_DOC_SOURCES.map((source) => [source.slug, source.path] as const))(
    '%s matches %s on disk',
    (slug, path) => {
      const onDisk = normalizeMarkdown(readFileSync(join(REPO_ROOT, path), 'utf8'));
      expect(DEVELOPER_DOCS[slug as DeveloperDocSlug]?.markdown === onDisk, `${path} changed — run ${REGENERATE}`).toBe(true);
    }
  );

  it(`is exactly what the generator writes (stale? run ${REGENERATE})`, () => {
    const committed = normalizeMarkdown(readFileSync(join(REPO_ROOT, GENERATED_MODULE_PATH), 'utf8'));
    expect(committed === buildDeveloperDocsModule(), `${GENERATED_MODULE_PATH} is stale — run ${REGENERATE}`).toBe(true);
  });

  it('lists the same documents as the generator, each in one navigation group', () => {
    expect([...DEVELOPER_DOC_SLUGS]).toEqual(DEVELOPER_DOC_SOURCES.map((source) => source.slug));
    const grouped = DEVELOPER_NAV_GROUPS.flatMap((group) => group.slugs);
    expect([...grouped].sort()).toEqual([...DEVELOPER_DOC_SLUGS].sort());
  });
});

/** Every link in a parsed document, in order. */
function linksIn(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const inline = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (node.type === 'link') out.push(node.href);
      if (node.type === 'image') out.push(node.src);
      if ('children' in node) inline(node.children);
    }
  };
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === 'heading' || block.type === 'paragraph') inline(block.children);
      else if (block.type === 'list') block.items.forEach((item) => walk(item.children));
      else if (block.type === 'blockquote') walk(block.children);
      else if (block.type === 'table') [block.head, ...block.rows].forEach((row) => row.forEach(inline));
    }
  };
  walk(blocks);
  return out;
}

const headingIds = (slug: DeveloperDocSlug) => new Set(parsedDeveloperDoc(slug).headings.map((heading) => heading.id));

describe('the rendered documents', () => {
  it.each(DEVELOPER_DOC_SLUGS)('%s: every link goes somewhere real', (slug) => {
    const problems: string[] = [];
    for (const href of linksIn(parsedDeveloperDoc(slug).blocks)) {
      const resolved = resolveDeveloperDocLink(slug, href);
      if (!resolved) {
        problems.push(`${href} → dropped (outside the repository, or an unsafe scheme)`);
        continue;
      }
      const [target, fragment] = resolved.href.split('#') as [string, string | undefined];
      if (target === '' || target.startsWith('/developers/')) {
        // An anchor on this site: the heading must exist.
        const targetSlug = (target === '' ? slug : target.slice('/developers/'.length)) as DeveloperDocSlug;
        if (!getDeveloperDoc(targetSlug)) problems.push(`${href} → no page ${target}`);
        else if (fragment && !headingIds(targetSlug).has(fragment)) problems.push(`${href} → no heading #${fragment}`);
      } else if (resolved.href.startsWith(BLOB)) {
        // A repository file shown on GitHub: the file must exist, and so
        // must the heading when the link names one in a Markdown file.
        const path = decodeURIComponent(target.slice(BLOB.length).split('?')[0]!);
        const file = join(REPO_ROOT, path);
        if (!existsSync(file)) problems.push(`${href} → ${path} does not exist`);
        else if (fragment && path.endsWith('.md')) {
          const ids = new Set(parseMarkdown(readFileSync(file, 'utf8')).headings.map((heading) => heading.id));
          if (!ids.has(fragment)) problems.push(`${href} → ${path} has no heading #${fragment}`);
        }
      }
    }
    expect(problems, `broken links in ${DEVELOPER_DOCS[slug].path}`).toEqual([]);
  });

  it.each(DEVELOPER_DOC_SLUGS)('%s: has a title, and no heading takes a page id', (slug) => {
    const doc = parsedDeveloperDoc(slug);
    expect(doc.title).toBeTruthy();
    for (const id of DEVELOPER_PAGE_IDS) expect(headingIds(slug).has(id)).toBe(false);
  });

  it('every overview card points at a real page and heading', () => {
    for (const card of BUILD_CARDS) {
      const [path, fragment] = card.href.split('#') as [string, string | undefined];
      const slug = path.slice('/developers/'.length) as DeveloperDocSlug;
      expect(getDeveloperDoc(slug), card.href).not.toBeNull();
      if (fragment) expect(headingIds(slug).has(fragment), `${card.href}: no such heading`).toBe(true);
    }
  });
});
