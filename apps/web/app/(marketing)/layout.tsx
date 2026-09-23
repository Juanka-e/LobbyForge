import type { ReactNode } from 'react';
import { Bricolage_Grotesque } from 'next/font/google';

/**
 * Marketing shell — wraps public-facing routes (landing) in the Calm
 * Future chrome. The root layout already provides the body background
 * and header, so this layout just adds the fixed top nav and a footer
 * that fit the design's marketing tone.
 *
 * The hub display face (Bricolage Grotesque) loads HERE only — the app
 * shell keeps Geist, so instance identity stays unchanged.
 *
 * Per ADR-006 the hub has NO sign-in: the nav offers Communities /
 * Connect, never a central login.
 */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const REPO = 'https://github.com/Juanka-e/LobbyForge';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${display.variable} flex flex-col flex-1`}>
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
    { label: 'Communities', href: '/discover' },
    { label: 'Connect', href: '/connect' },
    { label: 'Self-host', href: '/landing#self-host' },
    { label: 'GitHub', href: REPO },
  ];
  return (
    <nav className="bg-background/80 backdrop-blur-md fixed top-0 w-full z-50 border-b border-border-subtle/50 shadow-sm shadow-primary/5">
      <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop flex justify-between items-center h-20">
        <a href="/landing" className="font-display font-bold text-primary tracking-tight text-xl">
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
            href="/download"
            className="hidden md:block text-text-secondary hover:text-text-primary font-label-sm text-label-sm"
          >
            Download
          </a>
          <a
            href="/discover"
            className="bg-primary-container text-on-primary-container px-4 py-2 rounded-lg font-label-sm text-label-sm active:scale-95 duration-200 transition-all hover:brightness-110"
          >
            Explore communities
          </a>
        </div>
      </div>
    </nav>
  );
}

function MarketingFooter() {
  const footerLinks = [
    { label: 'GitHub', href: REPO },
    { label: 'Docs', href: `${REPO}/tree/main/docs` },
    { label: 'Communities', href: '/discover' },
    { label: 'Cloudflare guide', href: `${REPO}/blob/main/docs/DEPLOY_CLOUDFLARE.md` },
  ];
  return (
    <footer className="bg-surface-dim w-full pt-section-gap pb-12 border-t border-border-strong">
      <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop flex flex-col md:flex-row justify-between items-center gap-8">
        <div className="font-display font-bold text-text-muted">LobbyForge</div>
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
          © {new Date().getFullYear()} LobbyForge — self-hosted power for modern communities.
        </div>
      </div>
    </footer>
  );
}
