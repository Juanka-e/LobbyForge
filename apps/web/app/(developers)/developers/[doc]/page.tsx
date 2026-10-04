import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  DEVELOPER_DOC_SLUGS,
  getDeveloperDoc,
  parsedDeveloperDoc,
  resolveDeveloperDocLink,
} from '@/lib/developer-docs/registry';
import { getTranslator } from '@/lib/i18n/server';
import { buttonOutline, container, focusRing } from '@/app/(marketing)/_components/styles';
import DevelopersNav from '../_components/DevelopersNav';
import Markdown from '../_components/Markdown';
import TableOfContents from '../_components/TableOfContents';

/** One page per rendered document; any other slug is a 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return DEVELOPER_DOC_SLUGS.map((doc) => ({ doc }));
}

type Params = Promise<{ doc: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const doc = getDeveloperDoc((await params).doc);
  if (!doc) return {};
  const t = await getTranslator();
  return {
    title: t('developers.meta.docTitle', { title: t(doc.titleKey) }),
    description: t(doc.summaryKey),
  };
}

/**
 * A repository document, rendered: the section navigation, the document
 * (always English — the body is the repo's Markdown, not a catalogue
 * string), its table of contents, and a way to fix it on GitHub.
 */
export default async function DeveloperDocPage({ params }: { params: Params }) {
  const doc = getDeveloperDoc((await params).doc);
  if (!doc) notFound();
  const t = await getTranslator();
  const parsed = parsedDeveloperDoc(doc.slug);
  const resolveLink = (href: string) => resolveDeveloperDocLink(doc.slug, href);
  const englishOnly = t.locale.split('-')[0] !== 'en';
  const onThisPage = t('developers.doc.onThisPage');
  const editLink = (
    <a href={doc.editUrl} className={`${buttonOutline} h-9 shrink-0 rounded-lg px-3 text-[13.5px]`}>
      <span className="material-symbols-outlined text-[17px]" aria-hidden>
        edit
      </span>
      {t('developers.doc.editOnGitHub')}
    </a>
  );

  return (
    <div className={`${container} pb-20 pt-6 sm:pt-10 lg:pb-24`}>
      <a
        href="#developer-doc"
        className={`sr-only rounded-lg bg-surface px-4 py-2 text-sm text-text-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-20 focus:z-50 focus:px-4 focus:py-2 ${focusRing}`}
      >
        {t('developers.doc.skipToDoc')}
      </a>
      {/* minmax(0, …) everywhere: the pill row and wide tables scroll inside
          their own boxes instead of widening the page on a phone. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[210px_minmax(0,1fr)_220px]">
        <aside className="min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto lg:pb-4">
          <DevelopersNav t={t} current={doc.slug} />
        </aside>

        <div className="min-w-0">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            {englishOnly ? (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden>
                  translate
                </span>
                {t('developers.doc.englishOnly')}
              </p>
            ) : null}
            <div className="ml-auto">{editLink}</div>
          </div>

          {parsed.headings.some((heading) => heading.level === 2 || heading.level === 3) ? (
            <details className="group mb-8 rounded-xl border border-border-subtle bg-surface xl:hidden">
              <summary
                className={`flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-text-primary [&::-webkit-details-marker]:hidden ${focusRing}`}
              >
                {onThisPage}
                <span className="material-symbols-outlined text-[20px] text-text-muted transition-transform group-open:rotate-180" aria-hidden>
                  expand_more
                </span>
              </summary>
              <TableOfContents
                headings={parsed.headings}
                label={onThisPage}
                resolveLink={resolveLink}
                className="max-h-[60vh] overflow-y-auto border-t border-border-subtle/70 px-3 py-3"
              />
            </details>
          ) : null}

          <article
            id="developer-doc"
            tabIndex={-1}
            lang="en"
            className="break-words text-[16px] leading-[1.75] text-text-secondary outline-none"
          >
            <Markdown blocks={parsed.blocks} resolveLink={resolveLink} />
          </article>

          <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle/60 pt-6">
            <p className="font-mono text-xs text-text-muted">{doc.path}</p>
            {editLink}
          </div>
        </div>

        <aside className="hidden xl:sticky xl:top-24 xl:block xl:max-h-[calc(100dvh-7rem)] xl:self-start xl:overflow-y-auto xl:pb-4">
          <p aria-hidden className="mb-2 px-0.5 text-[11.5px] font-medium uppercase tracking-[0.14em] text-text-muted">
            {onThisPage}
          </p>
          <TableOfContents headings={parsed.headings} label={onThisPage} resolveLink={resolveLink} />
        </aside>
      </div>
    </div>
  );
}
