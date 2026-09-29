import Link from 'next/link';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { getTranslator } from '@/lib/i18n/server';
import type { HubNavLink } from './HubNavLinks';
import { focusRing } from './styles';

export default async function HubFooter() {
  const t = await getTranslator();
  const columns: Array<{ id: string; title: string; links: HubNavLink[] }> = [
    {
      id: 'hub-footer-product',
      title: t('hub.footer.product'),
      links: [
        { kind: 'internal', href: '/discover', label: t('hub.nav.communities') },
        { kind: 'internal', href: '/marketplace', label: t('hub.nav.marketplace') },
        { kind: 'internal', href: '/download', label: t('hub.nav.download') },
      ],
    },
    {
      id: 'hub-footer-developers',
      title: t('hub.footer.developers'),
      links: [
        { kind: 'external', href: LOBBYFORGE_REPO.docsUrl, label: t('hub.footer.documentation') },
        { kind: 'external', href: LOBBYFORGE_REPO.pluginSdkUrl, label: t('hub.footer.pluginSdk') },
        { kind: 'external', href: LOBBYFORGE_REPO.url, label: 'GitHub' },
      ],
    },
    {
      id: 'hub-footer-project',
      title: t('hub.footer.project'),
      links: [
        { kind: 'external', href: LOBBYFORGE_REPO.securityUrl, label: t('hub.footer.security') },
        { kind: 'external', href: LOBBYFORGE_REPO.contributingUrl, label: t('hub.footer.contributing') },
        { kind: 'external', href: LOBBYFORGE_REPO.licenseUrl, label: t('hub.footer.license', { license: LOBBYFORGE_REPO.license }) },
      ],
    },
  ];
  const linkClass = `rounded-sm text-sm text-text-secondary transition-colors hover:text-text-primary ${focusRing}`;

  return (
    <footer className="border-t border-border-subtle/60">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-x-6 gap-y-10 px-6 pb-12 pt-12 md:grid-cols-4 md:px-16 md:pt-14 xl:px-[100px]">
        <div className="col-span-2 flex flex-col gap-3 md:col-span-1">
          <span className="font-display text-[19px] font-bold text-text-primary">LobbyForge</span>
          <p className="text-sm leading-[1.6] text-text-muted">
            {t('hub.footer.tagline')}
            <br />
            {t('hub.footer.copyright', { year: new Date().getFullYear() })}
          </p>
        </div>
        {columns.map((column) => (
          <div key={column.id} className="flex flex-col gap-3">
            <p id={column.id} className="text-[13px] uppercase tracking-[0.12em] text-text-muted">
              {column.title}
            </p>
            <ul aria-labelledby={column.id} className="flex flex-col gap-3">
              {column.links.map((link) => (
                <li key={link.href}>
                  {link.kind === 'internal' ? (
                    <Link href={link.href} className={linkClass}>
                      {link.label}
                    </Link>
                  ) : (
                    <a href={link.href} className={linkClass}>
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
