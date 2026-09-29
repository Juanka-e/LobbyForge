import type { ReactNode } from 'react';
import HubShell from '@/app/(marketing)/_components/HubShell';
import { isOfficialDeployment } from '@/lib/deployment-mode';

/**
 * The community directory is an official-hub page: it gets the hub's
 * header and footer. (On a self-hosted instance these routes redirect to
 * the lobby, so there is nothing to wrap.)
 */
export default function DiscoverLayout({ children }: { children: ReactNode }) {
  if (!isOfficialDeployment()) return children;
  return <HubShell>{children}</HubShell>;
}
