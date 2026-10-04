import type { ReactNode } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { DEVELOPERS_PATH } from '@/lib/developer-docs/registry';
import { getTranslator } from '@/lib/i18n/server';
import { container, focusRing } from '@/app/(marketing)/_components/styles';

/**
 * The Developers pages on a self-hosted instance: a plain header with the
 * way back to the lobby, the content, a one-line footer. The official hub
 * wraps the same pages in its own chrome instead (see `../../layout.tsx`).
 *
 * The root layout already renders `<main>`; the content area here is the
 * skip link's target.
 */
export default async function DevelopersShell({ children }: { children: ReactNode }) {
  const t = await getTranslator();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-border-subtle/60 bg-background/85 backdrop-blur-md">
        <a
          href="#developers-content"
          className={`sr-only rounded-lg bg-surface px-4 py-2 text-sm text-text-primary focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:px-4 focus:py-2 ${focusRing}`}
        >
          {t('developers.shell.skip')}
        </a>
        <div className={`${container} flex h-14 items-center justify-between gap-4`}>
          <Link href={DEVELOPERS_PATH as Route} className={`flex min-w-0 items-baseline gap-2 rounded-md ${focusRing}`}>
            <span className="font-semibold text-text-primary">LobbyForge</span>
            <span className="truncate text-sm text-text-secondary">{t('developers.shell.title')}</span>
          </Link>
          <Link
            href="/lobby"
            className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary ${focusRing}`}
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden>
              arrow_back
            </span>
            {t('developers.shell.backToLobby')}
          </Link>
        </div>
      </header>
      <div id="developers-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </div>
      <footer className="border-t border-border-subtle/60">
        <div className={`${container} flex flex-wrap items-center justify-between gap-3 py-6 text-sm text-text-muted`}>
          <p>{t('developers.shell.footer', { license: LOBBYFORGE_REPO.license })}</p>
          <a href={LOBBYFORGE_REPO.url} className={`rounded-sm text-text-secondary transition-colors hover:text-text-primary ${focusRing}`}>
            {t('developers.shell.source')}
          </a>
        </div>
      </footer>
    </div>
  );
}
