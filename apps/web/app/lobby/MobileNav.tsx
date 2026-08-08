'use client';

import { useState, type ReactNode } from 'react';

/**
 * Mobile navigation wrapper — provides a hamburger button on small screens
 * that opens the server rail + channel sidebar as a slide-in drawer.
 *
 * On md+ screens the children render normally (no drawer). On mobile, a
 * fixed top bar with a menu button appears; tapping it slides the drawer
 * in from the left.
 *
 * Usage: wrap the <Sidebar> + <ServerRail> in <MobileNav>.
 */
export default function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar (visible below md) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
        aria-label="Open navigation"
      >
        <span className="material-symbols-outlined text-[20px]">menu</span>
      </button>

      {/* Drawer overlay */}
      {open ? (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      {/* Drawer content — slides in from left on mobile, static on md+ */}
      <div
        className={`fixed md:static inset-y-0 left-0 z-50 flex transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {children}
      </div>
    </>
  );
}
