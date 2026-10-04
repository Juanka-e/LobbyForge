import { describe, expect, it } from 'vitest';
import { resolveDocLink, type DocLinkContext } from '../links';

const context: DocLinkContext = {
  sourcePath: 'docs/EXTENDING.md',
  pages: {
    'docs/BOTS.md': '/developers/bots',
    'docs/EXTENDING.md': '/developers/extending',
    'docs/PLUGIN_SDK.md': '/developers/plugins',
  },
  repoUrl: 'https://github.com/Juanka-e/LobbyForge',
  branch: 'main',
};
const resolve = (href: string) => resolveDocLink(href, context);
const BLOB = 'https://github.com/Juanka-e/LobbyForge/blob/main';

describe('resolveDocLink', () => {
  it('rewrites a document that has a page to that page, keeping the fragment', () => {
    expect(resolve('BOTS.md#built-in-bots')).toEqual({ href: '/developers/bots#built-in-bots', external: false });
    expect(resolve('./PLUGIN_SDK.md')).toEqual({ href: '/developers/plugins', external: false });
    expect(resolve('../docs/BOTS.md')).toEqual({ href: '/developers/bots', external: false });
    expect(resolve('/docs/BOTS.md#errors')).toEqual({ href: '/developers/bots#errors', external: false });
  });

  it('sends any other repository file to GitHub, relative to the document', () => {
    expect(resolve('ARCHITECTURE_DECISIONS.md#adr-001-plugin-runtime-trust-model')).toEqual({
      href: `${BLOB}/docs/ARCHITECTURE_DECISIONS.md#adr-001-plugin-runtime-trust-model`,
      external: true,
    });
    expect(resolve('../packages/bot-sdk')).toEqual({ href: `${BLOB}/packages/bot-sdk`, external: true });
    expect(resolve('../README.md?plain=1')).toEqual({ href: `${BLOB}/README.md?plain=1`, external: true });
    expect(resolve('../apps/web/app/api/servers/[id]/route.ts')).toEqual({
      href: `${BLOB}/apps/web/app/api/servers/%5Bid%5D/route.ts`,
      external: true,
    });
  });

  it('points a link to the repository root at the repository', () => {
    expect(resolve('..')).toEqual({ href: 'https://github.com/Juanka-e/LobbyForge', external: true });
  });

  it('keeps in-page fragments and drops an empty one', () => {
    expect(resolve('#1-quick-answers')).toEqual({ href: '#1-quick-answers', external: false });
    expect(resolve('#')).toBeNull();
    expect(resolve('')).toBeNull();
  });

  it('keeps http, https and mailto links', () => {
    expect(resolve('https://www.w3.org/International/')).toEqual({ href: 'https://www.w3.org/International/', external: true });
    expect(resolve('HTTP://Example.COM/a')).toEqual({ href: 'http://example.com/a', external: true });
    expect(resolve('mailto:security@example.org')).toEqual({ href: 'mailto:security@example.org', external: true });
  });

  it('drops a link that climbs out of the repository', () => {
    expect(resolve('../../etc/passwd')).toBeNull();
    expect(resolve('../../../x.md')).toBeNull();
  });

  describe('drops dangerous links', () => {
    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      '\u0001javascript:alert(1)',
      'jav\u0000ascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'DATA:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.com/uuid',
      'about:blank',
      '//evil.example/x',
      '\\\\evil.example/x',
      '/\\evil.example/x',
      'https://',
    ])('%j', (href) => {
      expect(resolve(href)).toBeNull();
    });
  });

  it('never resolves to another host when built from a repository path', () => {
    for (const href of ['@evil.example', '..%2F..%2Fevil', 'x/../../../../evil.example', '%2F%2Fevil.example']) {
      const result = resolve(href);
      if (result) expect(new URL(result.href, 'https://hub.example').origin).toMatch(/^https:\/\/(github\.com|hub\.example)$/);
    }
  });
});
