'use client';

import { usePathname } from 'next/navigation';
import { isAppHeaderHidden } from '@/lib/hub-chrome';
import { useT } from '@/lib/i18n/client';

/**
 * The app's plain top bar. It steps aside wherever a page draws its own
 * chrome — the hub pages, the lobby, settings, sign-in; see
 * lib/hub-chrome.ts for the list and why.
 *
 * `showHealth`: the instance admin's Doctor link. Everyone else would only
 * find a 404 there, so they do not see it at all.
 */
export default function GlobalHeader({ official = false, showHealth = false }: { official?: boolean; showHealth?: boolean }) {
  const t = useT();
  const pathname = usePathname();
  if (isAppHeaderHidden(pathname, official)) return null;

  return (
    <header className="h-14 border-b border-border-subtle px-6 flex items-center gap-5 bg-surface">
      <a href="/" className="font-semibold text-text-primary">LobbyForge</a>
      <nav className="flex gap-4 text-label-sm text-text-secondary">
        <a href="/connect" className="hover:text-text-primary">{t('shell.header.connect')}</a>
        <a href="/settings" className="hover:text-text-primary">{t('shell.header.settings')}</a>
        {showHealth ? (
          <a href="/admin/health" className="hover:text-text-primary">{t('shell.header.health')}</a>
        ) : null}
      </nav>
    </header>
  );
}
