import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { rich } from '../rich';
import { createTranslator } from '../core';

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('rich', () => {
  it('puts the element where the sentence says, whatever the word order', () => {
    const link = <a href="/discover">Discover</a>;
    expect(html(rich('Try {link} instead.', { link }))).toBe('Try <a href="/discover">Discover</a> instead.');
    // Turkish puts it first; the code does not change.
    expect(html(rich('{link} sayfasını dene.', { link }))).toBe('<a href="/discover">Discover</a> sayfasını dene.');
  });

  it('fills several elements and leaves unknown markers visible', () => {
    expect(html(rich('{a} and {b} but not {c}', { a: <b>A</b>, b: <i>B</i> }))).toBe('<b>A</b> and <i>B</i> but not {c}');
  });

  it('composes with plain-text arguments and plurals from the translator', () => {
    const t = createTranslator('en', { k: 'Revoke {code}? It has {count, plural, one {# use} other {# uses}} left.' });
    expect(html(rich(t('k', { count: 2 }), { code: <code>ABC</code> }))).toBe('Revoke <code>ABC</code>? It has 2 uses left.');
  });
});
