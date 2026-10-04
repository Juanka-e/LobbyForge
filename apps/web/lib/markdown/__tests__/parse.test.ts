import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, type Block, type Inline } from '../parse';
import { createSlugger, slugify } from '../slug';

const blocks = (source: string) => parseMarkdown(source).blocks;
const text = (value: string): Inline => ({ type: 'text', value });
const code = (value: string): Inline => ({ type: 'code', value });

describe('headings', () => {
  it('reads ATX headings of every level and strips closing hashes', () => {
    expect(blocks('# One\n## Two ##\n###### Six')).toEqual([
      { type: 'heading', level: 1, id: 'one', children: [text('One')] },
      { type: 'heading', level: 2, id: 'two', children: [text('Two')] },
      { type: 'heading', level: 6, id: 'six', children: [text('Six')] },
    ]);
  });

  it('needs a space after the hashes, so #hashtag stays a paragraph', () => {
    expect(blocks('#hashtag')).toEqual([{ type: 'paragraph', children: [text('#hashtag')] }]);
  });

  it('reads setext headings', () => {
    expect(blocks('Title\n=====\n\nSub\n---')).toEqual([
      { type: 'heading', level: 1, id: 'title', children: [text('Title')] },
      { type: 'heading', level: 2, id: 'sub', children: [text('Sub')] },
    ]);
  });

  it('gives each heading a GitHub-compatible anchor, numbering repeats', () => {
    const doc = parseMarkdown(
      '# Bot API v2 — design contract\n## 3.2 The contract (`packages/plugin-sdk/src/index.ts`)\n## Errors\n## Errors\n## What M16 doesn\'t do'
    );
    expect(doc.headings.map((heading) => heading.id)).toEqual([
      'bot-api-v2--design-contract',
      '32-the-contract-packagesplugin-sdksrcindexts',
      'errors',
      'errors-1',
      'what-m16-doesnt-do',
    ]);
    expect(doc.title).toBe('Bot API v2 — design contract');
    expect(doc.headings[1]!.text).toBe('3.2 The contract (packages/plugin-sdk/src/index.ts)');
  });

  it('never gives a heading an id the page reserved', () => {
    const doc = parseMarkdown('## Hub content\n## Hub content', { reservedIds: ['hub-content'] });
    expect(doc.headings.map((heading) => heading.id)).toEqual(['hub-content-1', 'hub-content-2']);
  });
});

describe('slugs', () => {
  it('keeps letters of any script, digits, hyphens and underscores', () => {
    expect(slugify('Plugin SDK — Aşama 3 / Plugin SDK minimal')).toBe('plugin-sdk--aşama-3--plugin-sdk-minimal');
    expect(slugify('1.1 Channel access per bot (`bot_channel_access`)')).toBe('11-channel-access-per-bot-bot_channel_access');
  });

  it('numbers repeats like github-slugger, even across an existing -1', () => {
    const slug = createSlugger();
    expect([slug('A'), slug('A'), slug('A-1'), slug('A')]).toEqual(['a', 'a-1', 'a-1-1', 'a-2']);
  });

  it('never returns an empty id', () => {
    expect(createSlugger()('🎲')).toBe('section');
  });
});

describe('paragraphs and inline text', () => {
  it('joins lines into one paragraph, keeping soft breaks', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', children: [text('one\ntwo')] },
      { type: 'paragraph', children: [text('three')] },
    ]);
  });

  it('reads hard breaks from two trailing spaces or a backslash', () => {
    expect(parseInline('a  \nb\\\nc')).toEqual([text('a'), { type: 'break' }, text('b'), { type: 'break' }, text('c')]);
  });

  it('reads emphasis, strong and strikethrough, nested', () => {
    expect(parseInline('*em* **strong** _also em_ __also strong__ ~~gone~~ ***both***')).toEqual([
      { type: 'em', children: [text('em')] },
      text(' '),
      { type: 'strong', children: [text('strong')] },
      text(' '),
      { type: 'em', children: [text('also em')] },
      text(' '),
      { type: 'strong', children: [text('also strong')] },
      text(' '),
      { type: 'del', children: [text('gone')] },
      text(' '),
      { type: 'em', children: [{ type: 'strong', children: [text('both')] }] },
    ]);
  });

  it('leaves intraword underscores and lone asterisks alone', () => {
    expect(parseInline('snake_case_name and 2 * 3 * 4')).toEqual([text('snake_case_name and 2 * 3 * 4')]);
  });

  it('follows the rule of three', () => {
    expect(parseInline('*foo**bar*')).toEqual([{ type: 'em', children: [text('foo**bar')] }]);
  });

  it('reads code spans, which take precedence and keep their content literal', () => {
    expect(parseInline('use `a *b* [c](d)` and ``x ` y``')).toEqual([
      text('use '),
      code('a *b* [c](d)'),
      text(' and '),
      code('x ` y'),
    ]);
    expect(parseInline('`unclosed')).toEqual([text('`unclosed')]);
  });

  it('applies backslash escapes and character references', () => {
    expect(parseInline('\\*not em\\* &amp; &lt;b&gt; &#65;&#x42; &bogus;')).toEqual([text('*not em* & <b> AB &bogus;')]);
  });

  it('keeps raw HTML as text', () => {
    expect(parseInline('<script>alert(1)</script> <img src=x onerror=alert(1)>')).toEqual([
      text('<script>alert(1)</script> <img src=x onerror=alert(1)>'),
    ]);
  });
});

describe('links', () => {
  it('reads inline links with a title and formatted text', () => {
    expect(parseInline('[**BOTS.md** → Errors](BOTS.md#errors "The table")')).toEqual([
      {
        type: 'link',
        href: 'BOTS.md#errors',
        title: 'The table',
        children: [{ type: 'strong', children: [text('BOTS.md')] }, text(' → Errors')],
      },
    ]);
  });

  it('balances parentheses and reads <bracketed> destinations', () => {
    expect(parseInline('[a](https://x.example/a_(b)) [c](<d e.md>)')).toEqual([
      { type: 'link', href: 'https://x.example/a_(b)', title: null, children: [text('a')] },
      text(' '),
      { type: 'link', href: 'd e.md', title: null, children: [text('c')] },
    ]);
  });

  it('reads code inside link text', () => {
    expect(parseInline('[`docs/ACTIVITIES.md`](./ACTIVITIES.md)')).toEqual([
      { type: 'link', href: './ACTIVITIES.md', title: null, children: [code('docs/ACTIVITIES.md')] },
    ]);
  });

  it('reads autolinks and bare URLs, trimming trailing punctuation', () => {
    expect(parseInline('<https://a.example/x> <me@b.example> see https://c.example/path.')).toEqual([
      { type: 'link', href: 'https://a.example/x', title: null, children: [text('https://a.example/x')] },
      text(' '),
      { type: 'link', href: 'mailto:me@b.example', title: null, children: [text('me@b.example')] },
      text(' see '),
      { type: 'link', href: 'https://c.example/path', title: null, children: [text('https://c.example/path')] },
      text('.'),
    ]);
  });

  it('does not nest links, and leaves a bracket without a destination as text', () => {
    expect(parseInline('[outer [inner](a)](b)')).toEqual([
      text('[outer '),
      { type: 'link', href: 'a', title: null, children: [text('inner')] },
      text('](b)'),
    ]);
    expect(parseInline('[just brackets] and [x]')).toEqual([text('[just brackets] and [x]')]);
  });

  it('does not count a URL written as link text as a nested link', () => {
    expect(parseInline('[https://lobbyforge.org](https://lobbyforge.org)')).toEqual([
      { type: 'link', href: 'https://lobbyforge.org', title: null, children: [text('https://lobbyforge.org')] },
    ]);
  });

  it('resolves deeply nested brackets quickly, innermost link only', () => {
    const deep = `${'['.repeat(40)}x${'](a)'.repeat(40)}`;
    const started = performance.now();
    const nodes = parseInline(deep);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(nodes.filter((node) => node.type === 'link')).toHaveLength(1);
  });

  it('decodes references in a destination, so the renderer sees the real scheme', () => {
    expect(parseInline('[x](&#106;avascript:alert(1))')).toEqual([
      { type: 'link', href: 'javascript:alert(1)', title: null, children: [text('x')] },
    ]);
  });

  it('reads images', () => {
    expect(parseInline('![The *logo*](img/logo.png "Logo")')).toEqual([
      { type: 'image', src: 'img/logo.png', alt: 'The logo', title: 'Logo' },
    ]);
  });
});

describe('code blocks', () => {
  it('reads fenced code with a language, keeping its content verbatim', () => {
    expect(blocks('```ts\nconst a = `<b>` && 1;\n\n# not a heading\n```')).toEqual([
      { type: 'code', lang: 'ts', value: 'const a = `<b>` && 1;\n\n# not a heading' },
    ]);
  });

  it('reads tilde fences, longer closing fences, and an unclosed fence to the end', () => {
    expect(blocks('~~~\na\n~~~~~\n\n````sh\nb\n```\nc')).toEqual([
      { type: 'code', lang: null, value: 'a' },
      { type: 'code', lang: 'sh', value: 'b\n```\nc' },
    ]);
  });

  it('removes the fence indentation from its lines', () => {
    expect(blocks('  ```\n  indented\n    more\n  ```')).toEqual([{ type: 'code', lang: null, value: 'indented\n  more' }]);
  });

  it('reads indented code, but not as a paragraph continuation', () => {
    expect(blocks('    code line\n\n    second\n\ntext\n    continued')).toEqual([
      { type: 'code', lang: null, value: 'code line\n\nsecond' },
      { type: 'paragraph', children: [text('text\ncontinued')] },
    ]);
  });
});

describe('lists', () => {
  it('reads a tight bullet list with continuation lines', () => {
    expect(blocks('- one\n  still one\n- two')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: null,
        tight: true,
        items: [
          { children: [{ type: 'paragraph', children: [text('one\nstill one')] }] },
          { children: [{ type: 'paragraph', children: [text('two')] }] },
        ],
      },
    ]);
  });

  it('reads a loose ordered list with a start number', () => {
    const [list] = blocks('3. three\n\n4. four');
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3, tight: false });
    expect((list as Extract<Block, { type: 'list' }>).items).toHaveLength(2);
  });

  it('nests lists and keeps code blocks inside items', () => {
    const [list] = blocks('1. Step:\n   - a\n   - b\n2. Run:\n   ```sh\n   pnpm test\n   ```\n3. Done');
    expect(list).toEqual({
      type: 'list',
      ordered: true,
      start: 1,
      tight: true,
      items: [
        {
          children: [
            { type: 'paragraph', children: [text('Step:')] },
            {
              type: 'list',
              ordered: false,
              start: null,
              tight: true,
              items: [
                { children: [{ type: 'paragraph', children: [text('a')] }] },
                { children: [{ type: 'paragraph', children: [text('b')] }] },
              ],
            },
          ],
        },
        {
          children: [
            { type: 'paragraph', children: [text('Run:')] },
            { type: 'code', lang: 'sh', value: 'pnpm test' },
          ],
        },
        { children: [{ type: 'paragraph', children: [text('Done')] }] },
      ],
    });
  });

  it('makes an item loose when a blank line separates its blocks', () => {
    const [list] = blocks('- a\n\n  more of a\n- b');
    expect(list).toMatchObject({ type: 'list', tight: false });
  });

  it('starts a new list when the marker changes, and lets a list interrupt a paragraph', () => {
    expect(blocks('Intro:\n- a\n* b').map((block) => block.type)).toEqual(['paragraph', 'list', 'list']);
  });

  it('does not let an ordered list that starts past 1 interrupt a paragraph', () => {
    expect(blocks('It was the year\n1999. Then it ended.')).toEqual([
      { type: 'paragraph', children: [text('It was the year\n1999. Then it ended.')] },
    ]);
  });

  it('ends an item at a less-indented line after a blank line', () => {
    expect(blocks('- a\n\nafter').map((block) => block.type)).toEqual(['list', 'paragraph']);
  });

  it('accepts a lazy continuation line in a paragraph, but not after a fence', () => {
    const [lazy] = blocks('- one\ncontinued');
    expect(lazy).toMatchObject({ items: [{ children: [{ type: 'paragraph', children: [text('one\ncontinued')] }] }] });
    expect(blocks('- ```\n  x\n  ```\nafter').map((block) => block.type)).toEqual(['list', 'paragraph']);
  });

  it('prefers a thematic break over a list', () => {
    expect(blocks('- - -\n* * *')).toEqual([{ type: 'hr' }, { type: 'hr' }]);
  });
});

describe('tables', () => {
  it('reads alignment, inline content and escaped pipes (even in code)', () => {
    expect(blocks('| Left | Center | Right |\n|:---|:---:|---:|\n| `a\\|b` | **x** | 1 |\n| short |')).toEqual([
      {
        type: 'table',
        align: ['left', 'center', 'right'],
        head: [[text('Left')], [text('Center')], [text('Right')]],
        rows: [
          [[code('a|b')], [{ type: 'strong', children: [text('x')] }], [text('1')]],
          [[text('short')], [], []],
        ],
      },
    ]);
  });

  it('accepts rows without outer pipes and ends at a blank line', () => {
    const result = blocks('a | b\n--|--\n1 | 2\n\nafter');
    expect(result.map((block) => block.type)).toEqual(['table', 'paragraph']);
    expect(result[0]).toMatchObject({ align: [null, null], rows: [[[text('1')], [text('2')]]] });
  });

  it('is not a table when the delimiter row does not match the header', () => {
    expect(blocks('| a | b |\n|---|\n| 1 | 2 |').map((block) => block.type)).toEqual(['paragraph']);
  });

  it('starts right after a paragraph line, as GitHub does', () => {
    expect(blocks('Intro\n| a |\n| - |\n| 1 |').map((block) => block.type)).toEqual(['paragraph', 'table']);
  });
});

describe('block quotes and rules', () => {
  it('reads block quotes with nested blocks and lazy lines', () => {
    expect(blocks('> # Note\n> quoted\nlazy\n\n---')).toEqual([
      {
        type: 'blockquote',
        children: [
          { type: 'heading', level: 1, id: 'note', children: [text('Note')] },
          { type: 'paragraph', children: [text('quoted\nlazy')] },
        ],
      },
      { type: 'hr' },
    ]);
  });

  it('reads every thematic break form', () => {
    expect(blocks('***\n\n___\n\n- - -')).toEqual([{ type: 'hr' }, { type: 'hr' }, { type: 'hr' }]);
  });
});

describe('robustness', () => {
  it('normalises CRLF and NUL, and expands indentation tabs', () => {
    expect(blocks('# A\r\n\r\nb\u0000c\r\n\n-\tx')).toEqual([
      { type: 'heading', level: 1, id: 'a', children: [text('A')] },
      { type: 'paragraph', children: [text('b\uFFFDc')] },
      { type: 'list', ordered: false, start: null, tight: true, items: [{ children: [{ type: 'paragraph', children: [text('x')] }] }] },
    ]);
  });

  it('parses pathological input in linear-ish time', () => {
    const started = performance.now();
    parseMarkdown(`${'*a '.repeat(3000)}\n${'['.repeat(3000)}\n${'`'.repeat(3000)}\n${'- '.repeat(500)}x`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('inlineText flattens formatting', () => {
    expect(inlineText(parseInline('a *b* `c` [d](e) ![f](g)'))).toBe('a b c d f');
  });
});
