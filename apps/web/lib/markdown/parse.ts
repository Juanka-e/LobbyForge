/**
 * A small Markdown parser for the repository's own documents — no
 * dependencies, and output that is DATA (a tree of plain objects), never
 * HTML. The React renderer turns the tree into elements, so text always
 * reaches the page as text: raw HTML in a document shows up literally.
 *
 * It covers what the docs use, following CommonMark + GitHub's tables:
 *
 * - blocks: ATX and setext headings, paragraphs, fenced and indented code,
 *   bullet and ordered lists (nested, tight or loose), block quotes,
 *   tables with alignment, thematic breaks;
 * - inline: `code`, *emphasis*, **strong**, ~~strikethrough~~, links and
 *   images (inline form), <autolinks>, bare http(s) URLs, backslash
 *   escapes, character references, hard line breaks.
 *
 * Not covered (renders as text): reference-style links, footnotes, HTML.
 * Links are kept as written; deciding where they may point is the
 * renderer's job (see `links.ts`).
 */
import { createSlugger, type Slugger } from './slug';

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'em'; children: Inline[] }
  | { type: 'strong'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; title: string | null; children: Inline[] }
  | { type: 'image'; src: string; alt: string; title: string | null }
  | { type: 'break' };

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface ListItem {
  children: Block[];
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; start: number | null; tight: boolean; items: ListItem[] }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'table'; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

export interface MarkdownHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  id: string;
  /** The heading as plain text (what its anchor is made from). */
  text: string;
  children: Inline[];
}

export interface MarkdownDocument {
  blocks: Block[];
  /** Every heading, in document order — the table of contents' source. */
  headings: MarkdownHeading[];
  /** The text of the first level-1 heading, if any. */
  title: string | null;
}

export interface ParseOptions {
  /** Ids the page already uses; a heading never takes one of them. */
  reservedIds?: Iterable<string>;
}

export function parseMarkdown(source: string, options: ParseOptions = {}): MarkdownDocument {
  const text = source.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  const state: ParseState = { slug: createSlugger(options.reservedIds), headings: [] };
  const blocks = parseBlocks(text.split('\n').map(expandIndentTabs), state).blocks;
  const title = state.headings.find((heading) => heading.level === 1)?.text ?? null;
  return { blocks, headings: state.headings, title };
}

/** The plain text of inline content — for anchors, alt text and labels. */
export function inlineText(nodes: readonly Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'break':
        out += ' ';
        break;
      case 'image':
        out += node.alt;
        break;
      default:
        out += inlineText(node.children);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocks

interface ParseState {
  slug: Slugger;
  headings: MarkdownHeading[];
}

interface BlockResult {
  blocks: Block[];
  /** A blank line separated two of these blocks (makes a list item loose). */
  hasGap: boolean;
}

const ATX_HEADING = /^(#{1,6})(?=[ \t]|$)(.*)$/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_H1 = /^=+[ \t]*$/;
const SETEXT_H2 = /^-+[ \t]*$/;
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const TABLE_DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function stripIndent(line: string, count: number): string {
  let n = 0;
  while (n < count && n < line.length && line[n] === ' ') n++;
  return line.slice(n);
}

/** Tabs in a line's indentation count to the next multiple of four. */
function expandIndentTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') out += ' ';
    else if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else return out + line.slice(i);
  }
  return out;
}

interface ListMarker {
  ordered: boolean;
  /** `-`, `+`, `*`, or the ordered delimiter `.` / `)`. */
  delimiter: string;
  start: number | null;
  /** Column where the item's content starts. */
  contentIndent: number;
  /** The rest of the first line. */
  content: string;
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_MARKER.exec(line);
  if (!match) return null;
  const markerIndent = match[1]!.length;
  const marker = match[2]!;
  const ordered = /\d/.test(marker[0]!);
  const after = line.slice(markerIndent + marker.length);
  const width = markerIndent + marker.length;
  let contentIndent: number;
  let content: string;
  if (isBlank(after)) {
    contentIndent = width + 1;
    content = '';
  } else {
    const spaces = indentOf(after);
    // Five or more spaces: the item starts with indented code.
    if (spaces >= 5) {
      contentIndent = width + 1;
      content = after.slice(1);
    } else {
      contentIndent = width + spaces;
      content = after.slice(spaces);
    }
  }
  return {
    ordered,
    delimiter: ordered ? marker.slice(-1) : marker,
    start: ordered ? Number.parseInt(marker, 10) : null,
    contentIndent,
    content,
  };
}

function fenceOpen(line: string): { fence: string; info: string; indent: number } | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const match = FENCE_OPEN.exec(line.slice(indent));
  if (!match) return null;
  const fence = match[1]!;
  const info = match[2]!.trim();
  // A backtick fence's info string cannot itself contain a backtick.
  if (fence[0] === '`' && info.includes('`')) return null;
  return { fence, info, indent };
}

function isFenceClose(line: string, fence: string): boolean {
  const indent = indentOf(line);
  if (indent > 3) return false;
  const rest = line.slice(indent);
  const match = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
  return Boolean(match && match[1]![0] === fence[0] && match[1]!.length >= fence.length);
}

/** Does a line start a block that is not a paragraph continuation? */
function startsBlock(line: string): boolean {
  const indent = indentOf(line);
  if (indent > 3) return false;
  const rest = line.slice(indent);
  return (
    ATX_HEADING.test(rest) ||
    fenceOpen(line) !== null ||
    rest.startsWith('>') ||
    THEMATIC_BREAK.test(rest) ||
    listMarker(line) !== null
  );
}

/**
 * Could the next line be a lazy continuation of these lines? Only when
 * they end in paragraph text — not inside or right after a fenced code
 * block, and not on a heading, rule or table row.
 */
function endsInParagraph(lines: readonly string[]): boolean {
  let open: string | null = null;
  let closedOnLast = false;
  for (const line of lines) {
    closedOnLast = false;
    if (open === null) {
      const fence = fenceOpen(line);
      if (fence) open = fence.fence;
    } else if (isFenceClose(line, open)) {
      open = null;
      closedOnLast = true;
    }
  }
  if (open !== null || closedOnLast) return false;
  const last = lines[lines.length - 1];
  if (last === undefined || isBlank(last)) return false;
  const rest = last.slice(indentOf(last));
  return !ATX_HEADING.test(rest) && !THEMATIC_BREAK.test(rest) && !rest.includes('|');
}

/** Split a table row on unescaped pipes; `\|` is a literal pipe, even in code. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** A header line and a delimiter line with the same number of cells. */
function tableStart(header: string, delimiter: string | undefined): TableAlign[] | null {
  if (delimiter === undefined || !header.includes('|')) return null;
  if (indentOf(header) > 3 || indentOf(delimiter) > 3) return null;
  if (!delimiter.includes('|') || !TABLE_DELIMITER.test(delimiter.trim())) return null;
  const align = splitRow(delimiter).map(tableAlign);
  return splitRow(header).length === align.length ? align : null;
}

function parseBlocks(lines: readonly string[], state: ParseState): BlockResult {
  const blocks: Block[] = [];
  let hasGap = false;
  let pendingBlank = false;
  let paragraph: string[] | null = null;

  const push = (block: Block) => {
    if (pendingBlank && blocks.length > 0) hasGap = true;
    pendingBlank = false;
    blocks.push(block);
  };
  const heading = (level: number, raw: string) => {
    const children = parseInline(raw.trim());
    const text = inlineText(children).trim();
    const id = state.slug(text);
    const lvl = level as MarkdownHeading['level'];
    state.headings.push({ level: lvl, id, text, children });
    push({ type: 'heading', level: lvl, id, children });
  };
  const paragraphText = (rows: string[]) =>
    rows
      .map((row) => row.replace(/^[ \t]+/, ''))
      .join('\n')
      .replace(/[ \t]+$/, '');
  const flushParagraph = () => {
    if (paragraph === null) return;
    push({ type: 'paragraph', children: parseInline(paragraphText(paragraph)) });
    paragraph = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      flushParagraph();
      pendingBlank = true;
      i++;
      continue;
    }
    const indent = indentOf(line);

    if (indent >= 4) {
      // Indented code — unless it continues a paragraph.
      if (paragraph !== null) {
        paragraph.push(line);
        i++;
        continue;
      }
      const code: string[] = [];
      let last = i;
      while (i < lines.length && (isBlank(lines[i]!) || indentOf(lines[i]!) >= 4)) {
        code.push(stripIndent(lines[i]!, 4));
        if (!isBlank(lines[i]!)) last = i;
        i++;
      }
      code.length = last - (i - code.length) + 1;
      i = last + 1;
      push({ type: 'code', lang: null, value: code.join('\n') });
      continue;
    }

    const rest = line.slice(indent);

    const fence = fenceOpen(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i]!, fence.fence)) {
        body.push(stripIndent(lines[i]!, fence.indent));
        i++;
      }
      i++; // the closing fence (or the end of the container)
      const lang = fence.info.split(/\s+/)[0]?.replace(/\\(.)/g, '$1') || null;
      push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    const atx = ATX_HEADING.exec(rest);
    if (atx) {
      flushParagraph();
      const content = atx[2]!.trim().replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
      heading(atx[1]!.length, content);
      i++;
      continue;
    }

    if (paragraph !== null && SETEXT_H1.test(rest)) {
      const content = paragraphText(paragraph);
      paragraph = null;
      heading(1, content);
      i++;
      continue;
    }
    if (paragraph !== null && SETEXT_H2.test(rest)) {
      const content = paragraphText(paragraph);
      paragraph = null;
      heading(2, content);
      i++;
      continue;
    }

    if (THEMATIC_BREAK.test(rest)) {
      flushParagraph();
      push({ type: 'hr' });
      i++;
      continue;
    }

    if (rest.startsWith('>')) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const currentIndent = indentOf(current);
        if (currentIndent <= 3 && current[currentIndent] === '>') {
          let content = current.slice(currentIndent + 1);
          if (content.startsWith(' ')) content = content.slice(1);
          quoted.push(content);
          i++;
          continue;
        }
        // A lazy continuation line of a quoted paragraph.
        if (!isBlank(current) && !startsBlock(current) && endsInParagraph(quoted)) {
          quoted.push(current);
          i++;
          continue;
        }
        break;
      }
      push({ type: 'blockquote', children: parseBlocks(quoted, state).blocks });
      continue;
    }

    const align = tableStart(line, lines[i + 1]);
    if (align) {
      flushParagraph();
      const head = splitRow(line).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
        const cells = splitRow(lines[i]!);
        rows.push(align.map((_, column) => parseInline(cells[column] ?? '')));
        i++;
      }
      push({ type: 'table', align, head, rows });
      continue;
    }

    const marker = listMarker(line);
    // A list interrupts a paragraph only with content, and an ordered one
    // only when it starts at 1 — "in 1999. Then…" stays a sentence.
    if (marker && (paragraph === null || (marker.content !== '' && (!marker.ordered || marker.start === 1)))) {
      flushParagraph();
      const parsed = parseList(lines, i, state);
      i = parsed.next;
      push(parsed.list);
      continue;
    }

    if (paragraph === null) paragraph = [line];
    else paragraph.push(line);
    i++;
  }
  flushParagraph();
  return { blocks, hasGap };
}

function parseList(lines: readonly string[], from: number, state: ParseState): { list: Block; next: number } {
  const first = listMarker(lines[from]!)!;
  const items: ListItem[] = [];
  let tight = true;
  let i = from;

  while (i < lines.length) {
    const marker = listMarker(lines[i]!);
    if (!marker || marker.ordered !== first.ordered || marker.delimiter !== first.delimiter) break;
    const body: string[] = [marker.content];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        body.push('');
        i++;
        continue;
      }
      if (indentOf(line) >= marker.contentIndent) {
        body.push(stripIndent(line, marker.contentIndent));
        i++;
        continue;
      }
      // Less indented: a lazy paragraph continuation, or the item is over.
      if (startsBlock(line) || !endsInParagraph(body)) break;
      body.push(line.replace(/^[ \t]+/, ''));
      i++;
    }
    let trailingBlanks = 0;
    while (body.length > 1 && body[body.length - 1] === '') {
      body.pop();
      trailingBlanks++;
    }
    // A blank line that the item did not keep belongs before the next line.
    i -= trailingBlanks;
    const parsed = parseBlocks(body, state);
    items.push({ children: parsed.blocks });
    if (parsed.hasGap) tight = false;
    // Skip the blank lines; if the list goes on after them, it is loose.
    let next = i;
    while (next < lines.length && isBlank(lines[next]!)) next++;
    if (next > i) {
      const following = next < lines.length ? listMarker(lines[next]!) : null;
      if (following && following.ordered === first.ordered && following.delimiter === first.delimiter) {
        tight = false;
        i = next;
        continue;
      }
      break;
    }
  }

  return {
    list: { type: 'list', ordered: first.ordered, start: first.start, tight, items },
    next: i,
  };
}

// ---------------------------------------------------------------------------
// Inline

interface Delimiter {
  kind: 'delimiter';
  char: '*' | '_' | '~';
  count: number;
  originalCount: number;
  canOpen: boolean;
  canClose: boolean;
}

type InlineItem = Inline | Delimiter;

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  sect: '§',
  para: '¶',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  ne: '≠',
  le: '≤',
  ge: '≥',
};

/** `&amp;`, `&#38;`, `&#x26;` at `src[at]` → the character and the length read. */
function readEntity(src: string, at: number): { value: string; length: number } | null {
  const match = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(src.slice(at, at + 40));
  if (!match) return null;
  if (match[3] !== undefined) {
    const value = NAMED_ENTITIES[match[3]];
    return value === undefined ? null : { value, length: match[0].length };
  }
  const code = match[1] !== undefined ? Number.parseInt(match[1], 10) : Number.parseInt(match[2]!, 16);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return { value: valid ? String.fromCodePoint(code) : '\uFFFD', length: match[0].length };
}

function decodeEntities(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '&') {
      const entity = readEntity(value, i);
      if (entity) {
        out += entity.value;
        i += entity.length - 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

/** Backslash escapes in a link destination or title. */
function unescapePunctuation(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Where the backtick run starting at `from` (of length `run`) closes, or -1. */
function findCodeClose(src: string, from: number, run: number): number {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      let k = j;
      while (k < src.length && src[k] === '`') k++;
      if (k - j === run) return j;
      j = k;
    } else {
      j++;
    }
  }
  return -1;
}

interface LinkTail {
  href: string;
  title: string | null;
  /** Index just past the closing `)`. */
  end: number;
}

/**
 * The `(destination "title")` of an inline link, where `src[close]` is the
 * link text's `]` and `src[close + 1]` is `(`.
 */
function readLinkTail(src: string, close: number): LinkTail | null {
  if (src[close + 1] !== '(') return null;
  let p = close + 2;
  const skipSpace = () => {
    while (p < src.length && /[ \t\n]/.test(src[p]!)) p++;
  };
  skipSpace();
  let destination: string;
  if (src[p] === '<') {
    const end = src.slice(p + 1).search(/[<>\n]/);
    if (end === -1 || src[p + 1 + end] !== '>') return null;
    destination = src.slice(p + 1, p + 1 + end);
    p += end + 2;
  } else {
    const begin = p;
    let parens = 0;
    while (p < src.length) {
      const ch = src[p]!;
      if (ch === '\\' && ASCII_PUNCTUATION.test(src[p + 1] ?? '')) {
        p += 2;
        continue;
      }
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      } else if (WHITESPACE.test(ch) || ch < ' ') break;
      p++;
    }
    if (parens !== 0) return null;
    destination = src.slice(begin, p);
  }
  const beforeTitle = p;
  skipSpace();
  let title: string | null = null;
  const opener = src[p];
  if (p > beforeTitle && (opener === '"' || opener === "'" || opener === '(')) {
    const closer = opener === '(' ? ')' : opener;
    let q = p + 1;
    while (q < src.length && src[q] !== closer) {
      if (src[q] === '\\') q++;
      q++;
    }
    if (q >= src.length) return null;
    title = decodeEntities(unescapePunctuation(src.slice(p + 1, q)));
    p = q + 1;
    skipSpace();
  }
  if (src[p] !== ')') return null;
  return { href: decodeEntities(unescapePunctuation(destination)), title, end: p + 1 };
}

/** GitHub's bare-URL autolink at `text[at]`, trimmed of trailing punctuation. */
function readBareUrl(text: string, at: number): string | null {
  const match = /^https?:\/\/[A-Za-z0-9][^\s<]*/.exec(text.slice(at));
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const last = url[url.length - 1]!;
    if ('?!.,:*_~\'";'.includes(last)) {
      const entity = /&[A-Za-z0-9]+;$/.exec(url);
      url = entity ? url.slice(0, entity.index) : url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opened = url.split('(').length - 1;
      const closed = url.split(')').length - 1;
      if (closed > opened) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return /^https?:\/\/[A-Za-z0-9]/.test(url) ? url : null;
}

/**
 * Bare `http(s)://` URLs in text become links — after the links are built,
 * so a URL written as a link's text stays that link's text.
 */
function linkifyBareUrls(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.type === 'em' || node.type === 'strong' || node.type === 'del') {
      out.push({ ...node, children: linkifyBareUrls(node.children) });
      continue;
    }
    if (node.type !== 'text' || !/https?:\/\//.test(node.value)) {
      out.push(node);
      continue;
    }
    const value = node.value;
    let plain = '';
    let i = 0;
    while (i < value.length) {
      const boundary = i === 0 || /[\s*_~(]/.test(value[i - 1]!);
      const url = boundary && value[i] === 'h' ? readBareUrl(value, i) : null;
      if (url) {
        if (plain) out.push({ type: 'text', value: plain });
        plain = '';
        out.push({ type: 'link', href: url, title: null, children: [{ type: 'text', value: url }] });
        i += url.length;
      } else {
        plain += value[i];
        i++;
      }
    }
    if (plain) out.push({ type: 'text', value: plain });
  }
  return out;
}

/** Links never nest: an autolink inside link text keeps only its text. */
function unwrapLinks(nodes: readonly Inline[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'link') return unwrapLinks(node.children);
    if (node.type === 'em' || node.type === 'strong' || node.type === 'del') {
      return [{ ...node, children: unwrapLinks(node.children) }];
    }
    return [node];
  });
}

interface Bracket {
  /** Where its `[` / `![` text node sits in the item list. */
  itemIndex: number;
  image: boolean;
  /** Creation order, to tell whether a link formed after it. */
  sequence: number;
}

/**
 * Inline content. Links follow CommonMark's bracket algorithm, which is
 * linear: every `[` is remembered; a `]` followed by `(destination)`
 * closes the nearest one; and once a link forms, every earlier `[` can no
 * longer open one — links do not nest, the innermost wins.
 */
export function parseInline(src: string): Inline[] {
  const items: InlineItem[] = [];
  const brackets: Bracket[] = [];
  let sequence = 0;
  /** `[` brackets created at or before this sequence number are inactive. */
  let deactivatedThrough = -1;
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      items.push({ type: 'text', value: buffer });
      buffer = '';
    }
  };

  let pos = 0;
  while (pos < src.length) {
    const ch = src[pos]!;

    // Ordinary characters, in bulk.
    const plain = /^[^\\`<![\]*_~\n&]+/.exec(src.slice(pos, pos + 256));
    if (plain) {
      buffer += plain[0];
      pos += plain[0].length;
      continue;
    }

    if (ch === '\\') {
      const next = src[pos + 1];
      if (next === '\n') {
        flush();
        items.push({ type: 'break' });
        pos += 2;
        while (src[pos] === ' ' || src[pos] === '\t') pos++;
      } else if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
        buffer += next;
        pos += 2;
      } else {
        buffer += '\\';
        pos++;
      }
      continue;
    }

    if (ch === '`') {
      let run = 0;
      while (src[pos + run] === '`') run++;
      const close = findCodeClose(src, pos + run, run);
      if (close === -1) {
        buffer += '`'.repeat(run);
        pos += run;
        continue;
      }
      let value = src.slice(pos + run, close).replace(/\n/g, ' ');
      if (value.length >= 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') {
        value = value.slice(1, -1);
      }
      flush();
      items.push({ type: 'code', value });
      pos = close + run;
      continue;
    }

    if (ch === '<') {
      const rest = src.slice(pos, pos + 2048);
      const uri = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      const email = uri
        ? null
        : /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(
            rest
          );
      if (uri || email) {
        const target = (uri ?? email)![1]!;
        flush();
        items.push({
          type: 'link',
          href: uri ? target : `mailto:${target}`,
          title: null,
          children: [{ type: 'text', value: target }],
        });
        pos += target.length + 2;
        continue;
      }
      // Anything else that looks like HTML is just text.
      buffer += '<';
      pos++;
      continue;
    }

    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const image = ch === '!';
      flush();
      items.push({ type: 'text', value: image ? '![' : '[' });
      brackets.push({ itemIndex: items.length - 1, image, sequence: sequence++ });
      pos += image ? 2 : 1;
      continue;
    }

    if (ch === ']') {
      const opener = brackets.pop();
      const active = opener !== undefined && (opener.image || opener.sequence > deactivatedThrough);
      const tail = active ? readLinkTail(src, pos) : null;
      if (!opener || !tail) {
        buffer += ']';
        pos++;
        continue;
      }
      flush();
      const inside = items.splice(opener.itemIndex).slice(1);
      const children = unwrapLinks(resolveEmphasis(inside));
      if (opener.image) {
        items.push({ type: 'image', src: tail.href, alt: inlineText(children), title: tail.title });
      } else {
        items.push({ type: 'link', href: tail.href, title: tail.title, children });
        deactivatedThrough = sequence - 1;
      }
      pos = tail.end;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let end = pos;
      while (src[end] === ch) end++;
      const run = end - pos;
      if (ch === '~' && run !== 2) {
        buffer += src.slice(pos, end);
        pos = end;
        continue;
      }
      const before = pos === 0 ? ' ' : src[pos - 1]!;
      const after = end >= src.length ? ' ' : src[end]!;
      const spaceBefore = WHITESPACE.test(before);
      const spaceAfter = WHITESPACE.test(after);
      const punctBefore = UNICODE_PUNCTUATION.test(before);
      const punctAfter = UNICODE_PUNCTUATION.test(after);
      const leftFlanking = !spaceAfter && (!punctAfter || spaceBefore || punctBefore);
      const rightFlanking = !spaceBefore && (!punctBefore || spaceAfter || punctAfter);
      const canOpen = ch === '_' ? leftFlanking && (!rightFlanking || punctBefore) : leftFlanking;
      const canClose = ch === '_' ? rightFlanking && (!leftFlanking || punctAfter) : rightFlanking;
      flush();
      items.push({ kind: 'delimiter', char: ch, count: run, originalCount: run, canOpen, canClose });
      pos = end;
      continue;
    }

    if (ch === '\n') {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, '');
        flush();
        items.push({ type: 'break' });
      } else {
        buffer = buffer.replace(/ +$/, '') + '\n';
      }
      pos++;
      while (src[pos] === ' ' || src[pos] === '\t') pos++;
      continue;
    }

    if (ch === '&') {
      const entity = readEntity(src, pos);
      if (entity) {
        buffer += entity.value;
        pos += entity.length;
        continue;
      }
      buffer += '&';
      pos++;
      continue;
    }

    buffer += ch;
    pos++;
  }
  flush();
  return linkifyBareUrls(resolveEmphasis(items));
}

function isDelimiter(item: InlineItem): item is Delimiter {
  return 'kind' in item;
}

function asText(item: InlineItem): Inline {
  return isDelimiter(item) ? { type: 'text', value: item.char.repeat(item.count) } : item;
}

function mergeText(items: readonly InlineItem[]): Inline[] {
  const out: Inline[] = [];
  for (const raw of items) {
    const item = asText(raw);
    if (item.type === 'text' && item.value === '') continue;
    const last = out[out.length - 1];
    if (item.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', value: last.value + item.value };
    } else {
      out.push(item);
    }
  }
  return out;
}

/** CommonMark's "process emphasis": pair delimiter runs into em / strong / del. */
function resolveEmphasis(input: InlineItem[]): Inline[] {
  let list = input;
  let i = 0;
  while (i < list.length) {
    const closer = list[i]!;
    if (!isDelimiter(closer) || !closer.canClose || closer.count === 0) {
      i++;
      continue;
    }
    let openerAt = -1;
    for (let j = i - 1; j >= 0; j--) {
      const opener = list[j]!;
      if (!isDelimiter(opener) || opener.char !== closer.char || !opener.canOpen || opener.count === 0) continue;
      if (closer.char === '~') {
        if (opener.count === closer.count) {
          openerAt = j;
          break;
        }
        continue;
      }
      // The "rule of three": `*foo**bar*` is not `<em>foo</em><em>bar</em>`.
      const bothSided = opener.canClose || closer.canOpen;
      const sumMultipleOfThree = (opener.originalCount + closer.originalCount) % 3 === 0;
      const eachMultipleOfThree = opener.originalCount % 3 === 0 && closer.originalCount % 3 === 0;
      if (bothSided && sumMultipleOfThree && !eachMultipleOfThree) continue;
      openerAt = j;
      break;
    }
    if (openerAt === -1) {
      if (!closer.canOpen) list[i] = asText(closer);
      i++;
      continue;
    }
    const opener = list[openerAt] as Delimiter;
    const use = closer.char === '~' ? closer.count : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const children = mergeText(list.slice(openerAt + 1, i));
    const node: Inline =
      closer.char === '~'
        ? { type: 'del', children }
        : use === 2
          ? { type: 'strong', children }
          : { type: 'em', children };
    opener.count -= use;
    closer.count -= use;
    const before = list.slice(0, opener.count > 0 ? openerAt + 1 : openerAt);
    const after = list.slice(closer.count > 0 ? i : i + 1);
    list = [...before, node, ...after];
    i = before.length + 1;
  }
  return mergeText(list);
}
