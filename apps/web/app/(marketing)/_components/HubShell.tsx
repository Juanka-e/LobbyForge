import type { ReactNode } from 'react';
import EmailVerificationBanner from '@/components/email-verification/EmailVerificationBanner';
import { EmailStatusSeed } from '@/components/email-verification/email-status-store';
import { emailStatusForPage } from '@/lib/email-status-ssr';
import { getHubViewer } from '@/lib/hub-viewer';
import { hubDisplayFont } from './fonts';
import HubFooter from './HubFooter';
import HubNav from './HubNav';

/**
 * The official hub's chrome: header, content, footer — shared by the
 * marketing pages (landing, download, hub home) and, on the official
 * hub, the marketplace. Also where the hub's display face is attached,
 * so `font-display` resolves to Bricolage inside it and nowhere else.
 *
 * The root layout already renders the page's `<main>`, so the content
 * area here is a plain region with the skip link's target on it.
 */
export default async function HubShell({ children }: { children: ReactNode }) {
  const viewer = await getHubViewer();
  const emailStatus = viewer ? await emailStatusForPage(viewer.userId) : null;
  return (
    // The server-read email status seeds the banner and the hub's locked
    // forms (create a community) for the first paint.
    <EmailStatusSeed status={emailStatus}>
    <div className={`${hubDisplayFont.variable} flex min-h-dvh flex-col`}>
      <HubNav viewer={viewer} />
      {/* Signed-in hub accounts are asked to verify their email (EMAIL.md
          §4.2: publishing and listing need it on the hub). */}
      {viewer ? <EmailVerificationBanner enabled variant="hub" /> : null}
      <div id="hub-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </div>
      <HubFooter />
    </div>
    </EmailStatusSeed>
  );
}
