import type { ReactNode } from 'react';
import HubShell from '@/app/(marketing)/_components/HubShell';
import { isOfficialDeployment } from '@/lib/deployment-mode';

/**
 * On the official hub the marketplace is a hub page: it gets the hub's
 * header and footer. A self-hosted instance keeps the page's own header
 * with its way back to the lobby.
 */
export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  if (!isOfficialDeployment()) return children;
  return <HubShell>{children}</HubShell>;
}
