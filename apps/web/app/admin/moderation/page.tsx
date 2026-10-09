import type { Metadata } from 'next';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import SettingsShell from '@/app/SettingsShell';
import ModerationClient from './ModerationClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('moderation', 'admin.moderation.metaTitle');
}

export default async function ModerationPage() {
  const access = await requireAdminSection('moderation');
  return (
    <SettingsShell scope="community" sections={access.sections}>
      <ModerationClient />
    </SettingsShell>
  );
}
