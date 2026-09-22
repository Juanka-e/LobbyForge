'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

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
 * Entries are permission-gated: members see only what they may use, and
 * the admin links appear solely for MANAGE_SERVER holders.
 */

export interface LobbyServerMenuProps {
  serverName: string;
  instanceLogoUrl: string | null;
  /** Live server id — null in demo mode, where the menu is inert. */
  serverId: string | null;
  /** MANAGE_SERVER: unlocks the admin entries. */
  canManageServer: boolean;
  /** Official hub: offers "Add a community"; self-host is single-server. */
  isOfficial: boolean;
}

type MenuItem = {
  href: string;
  icon: string;
  label: string;
  /** Renders a divider above this entry. */
  separated?: boolean;
};

export function buildServerMenuItems({
  canManageServer,
  isOfficial,
}: {
  canManageServer: boolean;
  isOfficial: boolean;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (canManageServer) {
    items.push(
      { href: '/admin/settings', icon: 'admin_panel_settings', label: 'Server settings' },
      { href: '/admin/settings/members', icon: 'group', label: 'Members' },
      { href: '/admin/settings/channels', icon: 'forum', label: 'Channels' },
      { href: '/admin/settings/roles', icon: 'shield', label: 'Roles & permissions' },
      { href: '/admin/settings/invites', icon: 'link', label: 'Invites' },
      { href: '/admin/apps', icon: 'extension', label: 'Apps & activities' },
      { href: '/admin/health', icon: 'health_and_safety', label: 'Doctor & health' }
    );
  }
  items.push({
    href: '/settings',
    icon: 'manage_accounts',
    label: 'User settings',
    separated: canManageServer,
  });
  if (isOfficial) {
    items.push({ href: '/discover', icon: 'explore', label: 'Discover communities' });
    items.push({ href: '/instances/new', icon: 'add', label: 'Add a community' });
  }
  return items;
}

export function LobbyServerMenu({
  serverName,
  instanceLogoUrl,
  serverId,
  canManageServer,
  isOfficial,
}: LobbyServerMenuProps) {
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

  const items = serverId ? buildServerMenuItems({ canManageServer, isOfficial }) : [];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={items.length === 0}
        aria-expanded={open}
        aria-haspopup="menu"
        title={items.length === 0 ? serverName : `${serverName} — open the community menu`}
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
              {serverName.charAt(0).toUpperCase()}
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
          aria-label={`${serverName} menu`}
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
                {item.label}
              </Link>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
