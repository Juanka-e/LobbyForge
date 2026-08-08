import { notFound } from 'next/navigation';
import AuditPage from '@/app/admin/audit/page';
import BandwidthPage from '@/app/admin/bandwidth/page';
import HealthPage from '@/app/admin/health/page';
import UpdatesPage from '@/app/admin/updates/page';
import AdminSettingsPage from '@/app/admin/settings/page';
import AuthenticationPage from '@/app/admin/settings/authentication/page';
import BackupsPage from '@/app/admin/settings/backups/page';
import ChannelsPage from '@/app/admin/settings/channels/page';
import InvitesPage from '@/app/admin/settings/invites/page';
import MembersPage from '@/app/admin/settings/members/page';
import RolesPage from '@/app/admin/settings/roles/page';
import StoragePage from '@/app/admin/settings/storage/page';
import VoiceMediaPage from '@/app/admin/settings/voice-media/page';

const PAGES = {
  audit: AuditPage,
  bandwidth: BandwidthPage,
  health: HealthPage,
  updates: UpdatesPage,
  settings: AdminSettingsPage,
  'settings/authentication': AuthenticationPage,
  'settings/backups': BackupsPage,
  'settings/channels': ChannelsPage,
  'settings/invites': InvitesPage,
  'settings/members': MembersPage,
  'settings/roles': RolesPage,
  'settings/storage': StoragePage,
  'settings/voice-media': VoiceMediaPage,
} as const;

export default async function InterceptedAdminSettings({ params }: { params: Promise<{ slug?: string[] }> }) {
  const key = (await params).slug?.join('/') ?? '';
  const Page = PAGES[key as keyof typeof PAGES];
  if (!Page) notFound();
  return <Page />;
}
