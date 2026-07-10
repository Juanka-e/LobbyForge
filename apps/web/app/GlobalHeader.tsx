'use client';

import { usePathname } from 'next/navigation';

export default function GlobalHeader() {
  const pathname = usePathname();
  if (
    pathname === '/landing' ||
    pathname === '/login' ||
    pathname === '/setup' ||
    pathname.startsWith('/lobby') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/servers/')
  ) return null;

  return (
    <header className="h-14 border-b border-border-subtle px-6 flex items-center gap-5 bg-surface">
      <a href="/" className="font-semibold text-text-primary">LobbyForge</a>
      <nav className="flex gap-4 text-label-sm text-text-secondary">
        <a href="/connect" className="hover:text-text-primary">Connect</a>
        <a href="/settings" className="hover:text-text-primary">Settings</a>
        <a href="/admin/health" className="hover:text-text-primary">System Health</a>
      </nav>
    </header>
  );
}
