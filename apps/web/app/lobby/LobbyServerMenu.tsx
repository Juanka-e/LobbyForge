'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminMenuLink } from '@/lib/admin-sections';
import { useT } from '@/lib/i18n/client';
import { initialOf } from '@/lib/initial';

/**
 * The community header in the sidebar, and the dropdown it opens.
 *
 * beta-review: this used to be a CSS-only `group-hover` menu nested in a
 * container with `overflow-hidden`, which CLIPPED the absolutely
 * positioned panel — the menu was effectively unreachable, so clicking
 * the community name appeared to do nothing and the admin pages had no
 * entry point. It is now a real click menu (Escape / outside-click to
 * close, `aria-expanded` for assistive tech) rendered outside any
 * clipping container.
 *
 * Entries are permission-gated: each settings entry is one the page guard
 * will let this viewer open (`adminMenu`, resolved on the server by
 * lib/admin-access.ts) — a moderator with Kick Members gets Members and
 * nothing else; guests and members get none.
 */

export interface LobbyServerMenuProps {
  serverName: string;
  instanceLogoUrl: string | null;
  /** Live server id — null in demo mode, where the menu is inert. */
  serverId: string | null;
  /** The settings entries this viewer may open, in order (usually none). */
  adminMenu: readonly AdminMenuLink[];
  /** Official hub: offers "Add a community"; self-host is single-server. */
  isOfficial: boolean;
}

type MenuItem = {
  href: string;
  icon: string;
  /**
   * A message key, not text: this builder is a pure function with no
   * access to a translator, so the label is resolved where it renders.
   */
  labelKey: string;
  /** Renders a divider above this entry. */
  separated?: boolean;
};

export function buildServerMenuItems({
  adminMenu,
  isOfficial,
}: {
  adminMenu: readonly AdminMenuLink[];
  isOfficial: boolean;
}): MenuItem[] {
  const items: MenuItem[] = adminMenu.map((link) => ({ ...link }));
  items.push({
    href: '/settings',
    icon: 'manage_accounts',
    labelKey: 'lobby.server.userSettings',
    separated: adminMenu.length > 0,
  });
  if (isOfficial) {
    items.push({ href: '/discover', icon: 'explore', labelKey: 'lobby.server.discover' });
    items.push({ href: '/instances/new', icon: 'add', labelKey: 'lobby.server.addCommunity' });
  }
  return items;
}

export function LobbyServerMenu({
  serverName,
  instanceLogoUrl,
  serverId,
  adminMenu,
  isOfficial,
}: LobbyServerMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const items = serverId ? buildServerMenuItems({ adminMenu, isOfficial }) : [];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={items.length === 0}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          items.length === 0
            ? serverName
            : t('lobby.server.openMenu', { name: serverName })
        }
        className="h-16 px-4 flex items-center justify-between hover:bg-surface-container transition-colors duration-150 w-full text-left group disabled:cursor-default"
      >
        <div className="flex items-center gap-3 min-w-0">
          {instanceLogoUrl ? (
            // Instance logo (self-host branding) — also the favicon source.
            // eslint-disable-next-line @next/next/no-img-element -- data URL
            <img
              src={instanceLogoUrl}
              alt=""
              className="w-8 h-8 rounded-lg object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-secondary-container flex items-center justify-center flex-shrink-0 font-bold text-text-primary">
              {initialOf(serverName, { locale: t.locale })}
            </div>
          )}
          <span className="font-label-sm text-text-primary font-semibold whitespace-nowrap truncate">
            {serverName}
          </span>
        </div>
        {items.length > 0 ? (
          <span
            className={`material-symbols-outlined transition-transform text-[20px] text-text-secondary group-hover:text-text-primary ${
              open ? 'rotate-180' : ''
            }`}
          >
            expand_more
          </span>
        ) : null}
      </button>
      {open && items.length > 0 ? (
        <div
          role="menu"
          aria-label={t('lobby.server.menuLabel', { name: serverName })}
          className="absolute left-3 right-3 top-[60px] z-50 rounded-lg border border-border-subtle bg-surface-floating p-2 shadow-xl"
        >
          {items.map((item) => (
            <div key={item.href}>
              {item.separated ? <div className="my-1 h-px bg-border-subtle" /> : null}
              <Link
                role="menuitem"
                href={item.href}
                onClick={close}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
              >
                <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                {t(item.labelKey)}
              </Link>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
