import type { ReactNode } from 'react';
import HubShell from './_components/HubShell';

/**
 * Marketing shell — the official hub's public pages (landing, download)
 * and the signed-in hub home, all in the hub chrome. See `HubShell`.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <HubShell>{children}</HubShell>;
}
