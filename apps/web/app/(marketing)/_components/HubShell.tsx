import type { ReactNode } from 'react';
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
  return (
    <div className={`${hubDisplayFont.variable} flex min-h-dvh flex-col`}>
      <HubNav viewer={viewer} />
      <div id="hub-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </div>
      <HubFooter />
    </div>
  );
}
