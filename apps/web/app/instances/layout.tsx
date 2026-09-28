import type { ReactNode } from 'react';
import HubShell from '@/app/(marketing)/_components/HubShell';
import { isOfficialDeployment } from '@/lib/deployment-mode';

/**
 * Creating a community is an official-hub page, in the hub chrome. (On a
 * self-hosted instance the page redirects to the lobby.)
 */
export default function InstancesLayout({ children }: { children: ReactNode }) {
  if (!isOfficialDeployment()) return children;
  return <HubShell>{children}</HubShell>;
}
