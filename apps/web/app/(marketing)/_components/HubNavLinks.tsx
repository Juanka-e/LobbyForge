'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { focusRing } from './styles';

export type HubRoute =
  | '/home'
  | '/discover'
  | '/marketplace'
  | '/download'
  | '/landing'
  | '/developers'
  | '/developers/bots'
  | '/developers/plugins';

export type HubNavLink =
  | { kind: 'internal'; href: HubRoute; label: string }
  | { kind: 'external'; href: string; label: string };

/** Is `link` the page being shown (or a page inside it, like /discover/…)? */
export function isCurrent(link: HubNavLink, pathname: string | null): boolean {
  if (link.kind !== 'internal' || !pathname) return false;
  return pathname === link.href || pathname.startsWith(`${link.href}/`);
}

/**
 * The header's page links. `aria-current="page"` marks where the visitor
 * is — the signed-in hub draws it as a pill, as the design does.
 */
export default function HubNavLinks({
  links,
  label,
  variant,
  className = '',
}: {
  links: HubNavLink[];
  label: string;
  variant: 'plain' | 'pill';
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={className}>
      <ul className={`flex items-center ${variant === 'pill' ? 'gap-1.5' : 'gap-6 xl:gap-9'}`}>
        {links.map((link) => {
          const current = isCurrent(link, pathname);
          const shape =
            variant === 'pill'
              ? `flex h-10 items-center rounded-[10px] px-3.5 text-[15px] transition-colors ${
                  current ? 'bg-surface-raised text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`
              : `rounded-md py-1 text-[15px] transition-colors ${
                  current ? 'font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`;
          return (
            <li key={link.href}>
              {link.kind === 'internal' ? (
                <Link href={link.href} aria-current={current ? 'page' : undefined} className={`${shape} ${focusRing}`}>
                  {link.label}
                </Link>
              ) : (
                <a href={link.href} className={`${shape} ${focusRing}`}>
                  {link.label}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
