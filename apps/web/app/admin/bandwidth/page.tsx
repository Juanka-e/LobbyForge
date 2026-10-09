import type { Metadata } from 'next';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import SettingsShell from '@/app/SettingsShell';
import BandwidthClient from './BandwidthClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('bandwidth', 'admin.bandwidth.title');
}

/**
 * Admin bandwidth counter. This used to be a client page that rendered the
 * settings shell for anyone and told a refused visitor so once
 * `/api/admin/bandwidth` answered 403; it is now guarded on the server
 * like every admin page (instance admin only, as that route requires).
 */
export default async function BandwidthPage() {
  const access = await requireAdminSection('bandwidth');
  return (
    <SettingsShell scope="community" sections={access.sections}>
      <BandwidthClient />
    </SettingsShell>
  );
}
