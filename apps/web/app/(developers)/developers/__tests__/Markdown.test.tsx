// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { developerDocLinkContext } from '@/lib/developer-docs/registry';
import { resolveDocLink } from '@/lib/markdown/links';
import { parseMarkdown } from '@/lib/markdown/parse';
import Markdown, { languageName } from '../_components/Markdown';
import TableOfContents, { tocEntries } from '../_components/TableOfContents';

const render = (ui: ReactElement, locale = 'en') => rtlRender(<I18nProvider {...providerPropsFor(locale)}>{ui}</I18nProvider>);

/** Renders `source` as if it were docs/EXTENDING.md on the site. */
function renderDoc(source: string, locale = 'en') {
  const context = developerDocLinkContext('extending');
  const doc = parseMarkdown(source);
  return render(<Markdown blocks={doc.blocks} resolveLink={(href) => resolveDocLink(href, context)} />, locale);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Markdown — constructs', () => {
  it('renders headings with their anchors, one h1 per document', () => {
    renderDoc('# Title\n\n## 2.1 First `step`\n\n### Detail');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toHaveAttribute('id', 'title');
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2).toHaveAttribute('id', '21-first-step');
    expect(h2.querySelector('code')).toHaveTextContent('step');
    expect(screen.getByRole('heading', { level: 3, name: /Detail/ })).toHaveAttribute('id', 'detail');
    // The "#" permalink is a mouse convenience, hidden from assistive tech.
    const permalink = h2.querySelector('a[href="#21-first-step"]');
    expect(permalink).toHaveAttribute('aria-hidden', 'true');
    expect(permalink).toHaveAttribute('tabindex', '-1');
  });

  it('renders paragraphs with emphasis, strong, code, strikethrough and breaks', () => {
    const { container } = renderDoc('A *b* **c** `d` ~~e~~  \nf');
    const p = container.querySelector('p')!;
    expect(p.querySelector('em')).toHaveTextContent('b');
    expect(p.querySelector('strong')).toHaveTextContent('c');
    expect(p.querySelector('code')).toHaveTextContent('d');
    expect(p.querySelector('del')).toHaveTextContent('e');
    expect(p.querySelector('br')).not.toBeNull();
  });

  it('rewrites document links to their pages and other repo files to GitHub', () => {
    renderDoc(
      'See [Errors](BOTS.md#errors), [the ADR](ARCHITECTURE_DECISIONS.md#adr-001), [§2](#2-adding-bots) and [W3C](https://www.w3.org/).'
    );
    expect(screen.getByRole('link', { name: 'Errors' })).toHaveAttribute('href', '/developers/bots#errors');
    expect(screen.getByRole('link', { name: 'Errors' })).not.toHaveAttribute('rel');
    expect(screen.getByRole('link', { name: 'the ADR' })).toHaveAttribute(
      'href',
      'https://github.com/Juanka-e/LobbyForge/blob/main/docs/ARCHITECTURE_DECISIONS.md#adr-001'
    );
    expect(screen.getByRole('link', { name: '§2' })).toHaveAttribute('href', '#2-adding-bots');
    expect(screen.getByRole('link', { name: 'W3C' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders tight lists without paragraphs and loose ones with them, nested and numbered', () => {
    const { container } = renderDoc('- a\n  - a.1\n- b\n\n3. three\n\n4. four');
    const [ul] = Array.from(container.querySelectorAll(':scope > ul'));
    expect(ul!.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ul!.querySelector('p')).toBeNull();
    expect(ul!.querySelector('li > ul > li')).toHaveTextContent('a.1');
    const ol = container.querySelector('ol')!;
    expect(ol).toHaveAttribute('start', '3');
    expect(ol.querySelectorAll('li > p')).toHaveLength(2);
  });

  it('renders code blocks verbatim with a language label and a copy button', () => {
    const { container } = renderDoc('```ts\nconst x = `<b>`;\n```\n\n```\nplain\n```');
    const blocks = container.querySelectorAll('[data-code-block]');
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0] as HTMLElement).getByText('TypeScript')).toBeInTheDocument();
    expect(blocks[0]!.querySelector('pre code')!.textContent).toBe('const x = `<b>`;');
    expect(blocks[0]!.querySelector('pre')).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2);
    expect(blocks[1]!.querySelector('pre code')!.textContent).toBe('plain');
  });

  it('names fence languages and passes unknown ones through', () => {
    expect(languageName('sh')).toBe('Shell');
    expect(languageName('jsonc')).toBe('JSON');
    expect(languageName('zig')).toBe('zig');
    expect(languageName(null)).toBeNull();
  });

  it('renders tables with column headers, alignment and a scrollable, focusable frame', () => {
    const { container } = renderDoc('| Name | Count |\n|:-----|------:|\n| `a\\|b` | 2 |');
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent)).toEqual(['Name', 'Count']);
    expect(headers[0]).toHaveAttribute('scope', 'col');
    expect(headers[1]!.className).toContain('text-right');
    expect(within(table).getAllByRole('cell')[0]).toHaveTextContent('a|b');
    expect(container.querySelector('div[tabindex="0"] > table')).not.toBeNull();
  });

  it('renders block quotes and rules', () => {
    const { container } = renderDoc('> quoted **bit**\n\n---');
    expect(container.querySelector('blockquote p strong')).toHaveTextContent('bit');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('shows an image as a link to the file instead of embedding it', () => {
    const { container } = renderDoc('![The diagram](img/flow.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'The diagram' })).toHaveAttribute(
      'href',
      'https://github.com/Juanka-e/LobbyForge/blob/main/docs/img/flow.png'
    );
  });
});

describe('Markdown — hostile input', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">raw anchor</a>',
    '<svg onload=alert(1)><style>*{display:none}</style>',
    '[click](javascript:alert(1))',
    '[click2](JaVaScRiPt:alert(1) "t")',
    '[click3](&#106;avascript:alert(1))',
    '[click4](java%0ascript:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[vb](vbscript:msgbox(1))',
    '[proto](//evil.example)',
    '<javascript:alert(1)>',
    '![img](javascript:alert(1))',
    '![img2](data:image/svg+xml,<svg onload=alert(1)>)',
    '| <b onmouseover=alert(1)>cell</b> |\n|---|\n| [x](javascript:alert(1)) |',
    '```html\n<script>alert(1)</script>\n```',
    '`<img src=x onerror=alert(1)>`',
    '# <script>alert(1)</script>',
  ].join('\n\n');

  it('never creates script, image, frame, style or svg elements', () => {
    const { container } = renderDoc(attacks);
    for (const tag of ['script', 'img', 'iframe', 'svg', 'style', 'object', 'embed', 'b']) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
  });

  it('never renders an event-handler attribute', () => {
    const { container } = renderDoc(attacks);
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false);
      }
    }
  });

  it('only ever links to the site, GitHub, or a safe absolute URL', () => {
    const { container } = renderDoc(attacks);
    const hrefs = Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, href).toMatch(/^(#|\/developers\b|https:\/\/github\.com\/Juanka-e\/LobbyForge\b)/);
    }
  });

  it('shows the markup as text, so a reader can still see what the document says', () => {
    const { container } = renderDoc(attacks);
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    // A dropped link keeps its words.
    expect(screen.getByText('click')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'click' })).toBeNull();
  });
});

describe('copy button', () => {
  it('copies the block’s code and says so', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderDoc('```sh\npnpm test\n```');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(writeText).toHaveBeenCalledWith('pnpm test');
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Code copied to the clipboard.');
  });

  it('says when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    renderDoc('```\nx\n```');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy');
  });

  it('speaks the reader’s language', () => {
    renderDoc('```\nx\n```', 'tr');
    expect(screen.getByRole('button', { name: 'Kodu kopyala' })).toHaveTextContent('Kopyala');
  });
});

describe('table of contents', () => {
  const doc = parseMarkdown('# T\n## One\n### One a\n### One b\n## Two `code`\n#### Deep');

  it('nests third-level headings under their section and skips the title and deeper levels', () => {
    expect(tocEntries(doc.headings).map((entry) => [entry.heading.id, entry.children.map((child) => child.id)])).toEqual([
      ['one', ['one-a', 'one-b']],
      ['two-code', []],
    ]);
  });

  it('renders a named navigation of in-page links, without nested anchors', () => {
    render(<TableOfContents headings={doc.headings} label="On this page" resolveLink={() => ({ href: 'x', external: false })} />);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#one', '#one-a', '#one-b', '#two-code']);
    expect(nav.querySelector('a a')).toBeNull();
    expect(nav.querySelector('ol')).toHaveAttribute('lang', 'en');
  });
});

describe('a real document', () => {
  it('renders docs/PLUGIN_PUBLISHING.md (frozen copy) the same way every time', () => {
    const source = readFileSync(join(__dirname, 'fixtures', 'plugin-publishing.md'), 'utf8');
    const context = developerDocLinkContext('publishing');
    const doc = parseMarkdown(source);
    const { container } = render(<Markdown blocks={doc.blocks} resolveLink={(href) => resolveDocLink(href, context)} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Plugin Publishing Guide' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EXTENDING.md §3.3–3.5' })).toHaveAttribute(
      'href',
      '/developers/extending#33-path-a-compile-your-plugin-into-your-image-recommended'
    );
    expect(container).toMatchSnapshot();
  });
});
