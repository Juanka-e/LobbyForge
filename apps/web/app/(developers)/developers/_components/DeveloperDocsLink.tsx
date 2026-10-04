'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useT } from '@/lib/i18n/client';

const TARGETS = {
  bots: { href: '/developers/bots', labelKey: 'developers.adminLink.bots' },
  plugins: { href: '/developers/plugins', labelKey: 'developers.adminLink.plugins' },
} as const;

/**
 * "Bot developer docs" / "Plugin developer docs" — the way from a settings
 * page to the Developers section, which every deployment serves.
 */
export default function DeveloperDocsLink({ topic, className = '' }: { topic: keyof typeof TARGETS; className?: string }) {
  const t = useT();
  const target = TARGETS[topic];
  return (
    <Link
      href={target.href as Route}
      className={`inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className}`}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden>
        menu_book
      </span>
      {t(target.labelKey)}
    </Link>
  );
}
