import type { MarkdownHeading } from '@/lib/markdown/parse';
import { focusRing } from '@/app/(marketing)/_components/styles';
import { renderInlines, type LinkResolver } from './Markdown';

interface TocEntry {
  heading: MarkdownHeading;
  children: MarkdownHeading[];
}

/** Second-level headings, each with the third-level ones under it. */
export function tocEntries(headings: readonly MarkdownHeading[]): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const heading of headings) {
    if (heading.level === 2) entries.push({ heading, children: [] });
    else if (heading.level === 3) {
      const parent = entries[entries.length - 1];
      if (parent) parent.children.push(heading);
      else entries.push({ heading, children: [] });
    }
  }
  return entries;
}

const linkClass = `block rounded-md py-1 text-[13.5px] leading-snug text-text-secondary transition-colors hover:text-text-primary ${focusRing}`;

/**
 * "On this page": the document's sections as in-page links. The links are
 * the headings themselves, so the list is tagged English like the
 * document; the landmark's name stays in the reader's language.
 */
export default function TableOfContents({
  headings,
  label,
  resolveLink,
  className = '',
}: {
  headings: readonly MarkdownHeading[];
  /** The navigation landmark's name ("On this page"). */
  label: string;
  resolveLink: LinkResolver;
  className?: string;
}) {
  const entries = tocEntries(headings);
  if (entries.length === 0) return null;
  const text = (heading: MarkdownHeading) => renderInlines(heading.children, { resolveLink, links: false });
  return (
    <nav aria-label={label} className={className}>
      <ol lang="en" className="flex flex-col gap-0.5">
        {entries.map(({ heading, children }) => (
          <li key={heading.id}>
            <a href={`#${heading.id}`} className={linkClass}>
              {text(heading)}
            </a>
            {children.length > 0 ? (
              <ol className="mb-1 flex flex-col gap-0.5 border-l border-border-subtle/70 pl-3">
                {children.map((child) => (
                  <li key={child.id}>
                    <a href={`#${child.id}`} className={`${linkClass} text-[13px] text-text-muted`}>
                      {text(child)}
                    </a>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
