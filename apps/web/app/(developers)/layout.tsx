import type { ReactNode } from 'react';
import HubShell from '@/app/(marketing)/_components/HubShell';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import DevelopersShell from './developers/_components/DevelopersShell';

/**
 * The Developers section renders the repository's bot and plugin docs on
 * both deployments — they describe the software, not a community, so a
 * self-hosted instance serves them too. On the official hub they are hub
 * pages (hub header and footer); on a self-hosted instance they get a
 * plain standalone frame with the way back to the lobby.
 */
export default function DevelopersLayout({ children }: { children: ReactNode }) {
  if (isOfficialDeployment()) return <HubShell>{children}</HubShell>;
  return <DevelopersShell>{children}</DevelopersShell>;
}
