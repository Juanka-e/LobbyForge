import type { ReactNode } from 'react';
import type { ResolvedLink } from '@/lib/markdown/links';
import type { Block, Inline, ListItem, MarkdownHeading, TableAlign } from '@/lib/markdown/parse';
import { focusRing } from '@/app/(marketing)/_components/styles';
import CopyCodeButton from './CopyCodeButton';

/**
 * Renders a parsed Markdown tree (`lib/markdown/parse.ts`) as React
 * elements. Every piece of document text reaches the page as a text node
 * — there is no `dangerouslySetInnerHTML` here, so markup inside a
 * document is shown, never run — and every link goes through
 * `resolveLink`, which decides where it may point (null: plain text).
 *
 * A server component: only the code blocks' copy buttons hydrate.
 */

export type LinkResolver = (href: string) => ResolvedLink | null;

interface RenderContext {
  resolveLink: LinkResolver;
  /** Inside a tight list: paragraphs render without `<p>`. */
  tight: boolean;
  depth: number;
}

export const docLinkClass = `rounded-sm font-medium text-primary underline decoration-primary/40 underline-offset-[3px] transition-colors hover:decoration-primary ${focusRing}`;

/** Names for the fence languages the docs use; anything else shows as written. */
const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  mjs: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  console: 'Shell',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  rust: 'Rust',
  rs: 'Rust',
  nginx: 'nginx',
  ini: 'INI',
  text: 'Text',
  txt: 'Text',
};

export function languageName(lang: string | null): string | null {
  if (!lang) return null;
  return LANGUAGE_NAMES[lang.toLowerCase()] ?? lang;
}

const HEADING_CLASS: Record<MarkdownHeading['level'], string> = {
  1: 'font-display text-[32px] font-bold leading-[1.1] tracking-[-0.02em] text-text-primary text-balance sm:text-[42px]',
  2: 'mt-14 border-t border-border-subtle/60 pt-8 text-[24px] font-semibold leading-tight tracking-[-0.01em] text-text-primary sm:text-[27px]',
  3: 'mt-10 text-[19px] font-semibold leading-snug text-text-primary sm:text-xl',
  4: 'mt-8 text-[17px] font-semibold text-text-primary',
  5: 'mt-6 text-base font-semibold text-text-primary',
  6: 'mt-6 text-sm font-semibold uppercase tracking-[0.08em] text-text-secondary',
};

const ALIGN_CLASS: Record<Exclude<TableAlign, null>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

export interface InlineOptions {
  resolveLink: LinkResolver;
  /** False inside something that is already a link (the table of contents). */
  links?: boolean;
}

export function renderInlines(nodes: readonly Inline[], options: InlineOptions): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, index, options));
}

function renderInline(node: Inline, key: number, options: InlineOptions): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'break':
      return <br key={key} />;
    case 'code':
      return (
        <code key={key} className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[0.86em] text-text-primary">
          {node.value}
        </code>
      );
    case 'em':
      return <em key={key}>{renderInlines(node.children, options)}</em>;
    case 'strong':
      return (
        <strong key={key} className="font-semibold text-text-primary">
          {renderInlines(node.children, options)}
        </strong>
      );
    case 'del':
      return <del key={key}>{renderInlines(node.children, options)}</del>;
    case 'link': {
      const children = renderInlines(node.children, options);
      const resolved = options.links === false ? null : options.resolveLink(node.href);
      if (!resolved) return <span key={key}>{children}</span>;
      return (
        <a
          key={key}
          href={resolved.href}
          title={node.title ?? undefined}
          rel={resolved.external ? 'noopener noreferrer' : undefined}
          className={docLinkClass}
        >
          {children}
        </a>
      );
    }
    case 'image': {
      // Images are not embedded (the page's CSP would block most hosts
      // anyway): the alt text links to the file instead.
      const label = node.alt || node.src;
      const resolved = options.links === false ? null : options.resolveLink(node.src);
      if (!resolved) return <span key={key}>{label}</span>;
      return (
        <a key={key} href={resolved.href} rel={resolved.external ? 'noopener noreferrer' : undefined} className={docLinkClass}>
          {label}
        </a>
      );
    }
  }
}

function renderBlocks(blocks: readonly Block[], context: RenderContext): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, context));
}

function renderBlock(block: Block, key: number, context: RenderContext): ReactNode {
  const inline = (nodes: readonly Inline[]) => renderInlines(nodes, { resolveLink: context.resolveLink });
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return (
        <Tag key={key} id={block.id} className={`group scroll-mt-24 ${HEADING_CLASS[block.level]}`}>
          {inline(block.children)}
          {block.level > 1 ? (
            // A mouse convenience for copying a section's address; keyboard
            // and screen-reader users have the table of contents.
            <a
              href={`#${block.id}`}
              aria-hidden
              tabIndex={-1}
              className="ml-2 font-normal text-text-muted no-underline opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            >
              #
            </a>
          ) : null}
        </Tag>
      );
    }
    case 'paragraph':
      if (context.tight) return <span key={key}>{inline(block.children)}</span>;
      return (
        <p key={key} className={context.depth > 0 ? 'my-2.5' : 'my-4'}>
          {inline(block.children)}
        </p>
      );
    case 'code':
      return <CodeBlock key={key} lang={block.lang} value={block.value} />;
    case 'list': {
      const items = block.items.map((item, index) => (
        <ListItemView key={index} item={item} context={{ ...context, tight: block.tight, depth: context.depth + 1 }} />
      ));
      const spacing = `${context.depth > 0 ? 'my-2' : 'my-4'} ${block.tight ? 'space-y-1.5' : 'space-y-1'} pl-6 marker:text-text-muted`;
      return block.ordered ? (
        <ol key={key} start={block.start !== null && block.start !== 1 ? block.start : undefined} className={`list-decimal ${spacing}`}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={`list-disc ${spacing}`}>
          {items}
        </ul>
      );
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="my-5 border-l-[3px] border-primary/50 pl-4 text-text-secondary">
          {renderBlocks(block.children, { ...context, tight: false })}
        </blockquote>
      );
    case 'table':
      return (
        <div
          key={key}
          // Focusable so a keyboard can scroll a table wider than the page.
          tabIndex={0}
          className={`my-6 overflow-x-auto rounded-xl border border-border-subtle ${focusRing}`}
        >
          <table
            // Wide tables keep readable columns and scroll inside the frame
            // on a phone rather than squeezing every column to a word.
            className={`w-full border-collapse text-left text-[14px] leading-[1.55] ${block.head.length >= 3 ? 'min-w-[36rem]' : ''}`}
          >
            <thead className="bg-surface-raised">
              <tr>
                {block.head.map((cell, column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`border-b border-border-subtle px-3.5 py-2.5 font-semibold text-text-primary ${alignClass(block.align[column])}`}
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border-subtle/60 last:border-b-0">
                  {row.map((cell, column) => (
                    <td key={column} className={`px-3.5 py-2.5 align-top ${alignClass(block.align[column])}`}>
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} className="my-10 border-border-subtle" />;
  }
}

function alignClass(align: TableAlign | undefined): string {
  return align ? ALIGN_CLASS[align] : '';
}

function ListItemView({ item, context }: { item: ListItem; context: RenderContext }) {
  return <li className="pl-1">{renderBlocks(item.children, context)}</li>;
}

function CodeBlock({ lang, value }: { lang: string | null; value: string }) {
  const label = languageName(lang);
  return (
    <div data-code-block className="my-5 overflow-hidden rounded-xl border border-border-subtle bg-surface-container">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border-subtle/70 py-1 pl-4 pr-1.5">
        <span className="font-mono text-xs text-text-muted">{label}</span>
        <CopyCodeButton />
      </div>
      <pre
        // Focusable so a keyboard can scroll a long line into view.
        tabIndex={0}
        className={`overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.65] text-text-primary ${focusRing} focus-visible:outline-offset-[-2px]`}
      >
        <code>{value}</code>
      </pre>
    </div>
  );
}

/**
 * A document. Its first-level heading is the page's `<h1>`, so render one
 * document per page.
 */
export default function Markdown({ blocks, resolveLink }: { blocks: readonly Block[]; resolveLink: LinkResolver }) {
  return <>{renderBlocks(blocks, { resolveLink, tight: false, depth: 0 })}</>;
}
