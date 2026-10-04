// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor, translatorFor } from '@/lib/i18n/catalogue';
import { DEVELOPER_DOCS, DEVELOPER_DOC_SLUGS } from '@/lib/developer-docs/docs.generated';

const state = vi.hoisted(() => ({ locale: 'en', official: false }));

vi.mock('@/lib/i18n/server', () => ({ getTranslator: async () => translatorFor(state.locale) }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => state.official }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The hub chrome reads cookies and GitHub; here it only has to be recognisable.
vi.mock('@/app/(marketing)/_components/HubShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="hub-shell">{children}</div>,
}));

import DevelopersLayout from '../../layout';
import DevelopersPage from '../page';
import DeveloperDocPage, { generateMetadata, generateStaticParams } from '../[doc]/page';
import DevelopersShell from '../_components/DevelopersShell';
import { BUILD_CARDS } from '../_components/build-cards';

const render = (ui: ReactElement) => rtlRender(<I18nProvider {...providerPropsFor(state.locale)}>{ui}</I18nProvider>);
const params = (doc: string) => ({ params: Promise.resolve({ doc }) });

/** The document's first `# ` line, read straight from the Markdown. */
function firstHeading(markdown: string): string {
  const line = /^# (.+)$/m.exec(markdown)?.[1] ?? '';
  return line.replace(/[`*_]/g, '').trim();
}

beforeEach(() => {
  state.locale = 'en';
  state.official = false;
});

describe('/developers/[doc]', () => {
  it('has a page for every generated document and no other', () => {
    expect(generateStaticParams()).toEqual(DEVELOPER_DOC_SLUGS.map((doc) => ({ doc })));
  });

  it.each(DEVELOPER_DOC_SLUGS)('/developers/%s renders its document, first heading as the page title', async (slug) => {
    render(await DeveloperDocPage(params(slug)));
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(firstHeading(DEVELOPER_DOCS[slug].markdown));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The body is the repo's English, whatever the reader's language.
    expect(h1.closest('article')).toHaveAttribute('lang', 'en');
    const edit = screen.getAllByRole('link', { name: 'Edit on GitHub' });
    expect(edit[0]).toHaveAttribute('href', `https://github.com/Juanka-e/LobbyForge/edit/main/${DEVELOPER_DOCS[slug].path}`);
    // The section navigation marks this page.
    const current = screen.getAllByRole('link', { current: 'page' });
    expect(current.every((link) => link.getAttribute('href') === `/developers/${slug}`)).toBe(true);
  });

  it('offers a skip link to the document and a named table of contents', async () => {
    render(await DeveloperDocPage(params('bots')));
    expect(screen.getByRole('link', { name: 'Skip to the document' })).toHaveAttribute('href', '#developer-doc');
    expect(document.getElementById('developer-doc')?.tagName).toBe('ARTICLE');
    const toc = screen.getAllByRole('navigation', { name: 'On this page' });
    expect(toc.length).toBeGreaterThan(0);
    expect(within(toc[0]!).getByRole('link', { name: 'Built-in bots' })).toHaveAttribute('href', '#built-in-bots');
  });

  it('rewrites links between rendered documents to their pages', async () => {
    render(await DeveloperDocPage(params('extending')));
    const article = document.getElementById('developer-doc')!;
    const hrefs = Array.from(article.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);
    expect(hrefs).toContain('/developers/bots#built-in-bots');
    expect(hrefs.some((href) => href.endsWith('.md') && href.startsWith('/'))).toBe(false);
  });

  it('says in Turkish that the document is English, and keeps the chrome Turkish', async () => {
    state.locale = 'tr';
    render(await DeveloperDocPage(params('plugins')));
    expect(screen.getByText('Bu belge İngilizcedir.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: "GitHub'da düzenle" }).length).toBeGreaterThan(0);
  });

  it('shows no language note to an English reader', async () => {
    render(await DeveloperDocPage(params('plugins')));
    expect(screen.queryByText('This document is in English.')).toBeNull();
  });

  it('is a 404 for any other slug', async () => {
    await expect(DeveloperDocPage(params('secrets'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(DeveloperDocPage(params('../../etc/passwd'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await generateMetadata(params('secrets'))).toEqual({});
  });

  it('titles the page in the reader’s language', async () => {
    expect(await generateMetadata(params('bot-api-v2'))).toMatchObject({ title: 'Bot API v2 — LobbyForge developers' });
    state.locale = 'tr';
    expect(await generateMetadata(params('publishing'))).toMatchObject({
      title: 'Eklenti yayınlama — LobbyForge geliştiricileri',
    });
  });
});

describe('/developers', () => {
  it('lists what can be built, each card linking to its guide', async () => {
    render(await DevelopersPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Build bots, games and tools for LobbyForge' })).toBeInTheDocument();
    const build = within(screen.getByRole('region', { name: 'What you can build' }));
    for (const card of BUILD_CARDS) {
      const title = translatorFor('en')(`developers.overview.card.${card.id}.title`);
      expect(build.getByRole('link', { name: title })).toHaveAttribute('href', card.href);
    }
    expect(build.getByRole('link', { name: 'Slash commands' })).toBeInTheDocument();
    expect(build.getByRole('link', { name: 'Webhooks' })).toBeInTheDocument();
  });

  it('links every guide and the repository', async () => {
    render(await DevelopersPage());
    const guides = screen.getByRole('heading', { name: 'Read the guides' }).closest('section')!;
    const hrefs = within(guides).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(DEVELOPER_DOC_SLUGS.map((slug) => `/developers/${slug}`));
    expect(screen.getByRole('link', { name: 'View the source on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Juanka-e/LobbyForge'
    );
  });

  it('renders in Turkish', async () => {
    state.locale = 'tr';
    render(await DevelopersPage());
    expect(screen.getByRole('heading', { level: 1, name: 'LobbyForge için bot, oyun ve araç geliştir' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Eğik çizgi komutları' })).toBeInTheDocument();
  });
});

describe('the section frame', () => {
  it('is the hub chrome on the official hub', () => {
    state.official = true;
    render(DevelopersLayout({ children: <p>doc</p> }) as ReactElement);
    expect(screen.getByTestId('hub-shell')).toHaveTextContent('doc');
  });

  it('is a standalone frame on a self-hosted instance, with the way back to the lobby', async () => {
    render(await DevelopersShell({ children: <p>doc</p> }));
    expect(screen.queryByTestId('hub-shell')).toBeNull();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#developers-content');
    expect(document.getElementById('developers-content')).toHaveTextContent('doc');
    expect(screen.getByRole('link', { name: 'Back to the lobby' })).toHaveAttribute('href', '/lobby');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('AGPL-3.0');
  });

  it('picks the standalone frame when not official', () => {
    const element = DevelopersLayout({ children: <p>doc</p> }) as ReactElement;
    expect(element.type).toBe(DevelopersShell);
  });
});
