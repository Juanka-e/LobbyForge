import type { ReactNode } from 'react';

/**
 * Marketing shell — wraps public-facing routes (landing) in the Calm
 * Future chrome. The root layout already provides the body background
 * and header, so this layout just adds the fixed top nav and a footer
 * that fit the design's marketing tone.
 *
 * The (marketing) route group keeps URL paths simple (e.g. /landing
 * not /marketing/landing) and lets us evolve the marketing shell
 * without affecting the in-app chrome.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col flex-1">
      <MarketingNav />
      <main className="flex-grow pt-32 pb-section-gap flex flex-col gap-section-gap">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}

function MarketingNav() {
  const navLinks = [
    { label: 'Product', href: '#' },
    { label: 'Apps', href: '#' },
    { label: 'Self-host', href: '#' },
    { label: 'Docs', href: '#' },
    { label: 'GitHub', href: '#' },
  ];
  return (
    <nav className="bg-background/80 backdrop-blur-md fixed top-0 w-full z-50 border-b border-border-subtle/50 shadow-sm shadow-primary/5">
      <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop flex justify-between items-center h-20">
        <a href="/landing" className="font-body-lg font-bold text-primary tracking-tight">
          LobbyForge
        </a>
        <div className="hidden md:flex gap-8">
          {navLinks.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-text-secondary hover:text-text-primary transition-colors hover:bg-surface-variant/30 rounded-lg px-3 py-2"
            >
              {l.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <a
            href="/connect"
            className="hidden md:block text-text-secondary hover:text-text-primary font-label-sm text-label-sm"
          >
            Sign In
          </a>
          <a
            href="/lobby"
            className="bg-primary-container text-[#07101E] px-4 py-2 rounded-lg font-label-sm text-label-sm active:scale-95 duration-200 transition-all hover:brightness-110"
          >
            Open Hub
          </a>
        </div>
      </div>
    </nav>
  );
}

function MarketingFooter() {
  const footerLinks = [
    { label: 'GitHub', href: '#' },
    { label: 'Docs', href: '#' },
    { label: 'Community', href: '#' },
    { label: 'Privacy', href: '#' },
    { label: 'Terms', href: '#' },
  ];
  return (
    <footer className="bg-surface-dim w-full pt-section-gap pb-12 border-t border-border-strong">
      <div className="max-w-container-max mx-auto px-margin-desktop flex flex-col md:flex-row justify-between items-center gap-8">
        <div className="font-body-md font-bold text-text-muted">LobbyForge</div>
        <div className="flex gap-6 flex-wrap justify-center font-label-sm text-label-sm">
          {footerLinks.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-text-muted hover:text-text-secondary transition-colors hover:underline decoration-primary/50 underline-offset-4"
            >
              {l.label}
            </a>
          ))}
        </div>
        <div className="font-label-sm text-label-sm text-text-muted">
          © 2024 LobbyForge. Self-hosted power for modern communities.
        </div>
      </div>
    </footer>
  );
}
