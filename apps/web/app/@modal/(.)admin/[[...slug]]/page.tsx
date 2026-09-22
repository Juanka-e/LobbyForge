import { notFound } from 'next/navigation';
import AppsPage from '@/app/admin/apps/page';
import AuditPage from '@/app/admin/audit/page';
import BandwidthPage from '@/app/admin/bandwidth/page';
import HealthPage from '@/app/admin/health/page';
import ModerationPage from '@/app/admin/moderation/page';
import PluginsPage from '@/app/admin/plugins/page';
import UpdatesPage from '@/app/admin/updates/page';
import UpdateRunPage from '@/app/admin/updates/[runId]/page';
import AdminSettingsPage from '@/app/admin/settings/page';
import AuthenticationPage from '@/app/admin/settings/authentication/page';
import BackupsPage from '@/app/admin/settings/backups/page';
import ChannelsPage from '@/app/admin/settings/channels/page';
import InvitesPage from '@/app/admin/settings/invites/page';
import MembersPage from '@/app/admin/settings/members/page';
import RolesPage from '@/app/admin/settings/roles/page';
import StoragePage from '@/app/admin/settings/storage/page';
import VoiceMediaPage from '@/app/admin/settings/voice-media/page';

/**
 * Admin routes intercepted into the `@modal` slot, so opening them from
 * the lobby overlays the community instead of replacing it.
 *
 * beta-review: this map is a HARD ALLOWLIST — anything missing from it
 * hits `notFound()` and the user sees "404 This page could not be
 * found." on click, while a hard reload of the same URL works. That is
 * exactly what happened to `/admin/plugins` and `/admin/moderation`:
 * both pages existed and were listed in the settings nav, but neither
 * was registered here. `admin-modal-routes.test.ts` now walks
 * `app/admin/**` and fails the build if a page is not represented,
 * so the next admin page cannot silently 404 the same way.
 */
const PAGES = {
  apps: AppsPage,
  audit: AuditPage,
  bandwidth: BandwidthPage,
  health: HealthPage,
  moderation: ModerationPage,
  plugins: PluginsPage,
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

/** Registered dynamic routes: `updates/<runId>` is the only one today. */
const UPDATE_RUN_PREFIX = 'updates/';

export default async function InterceptedAdminSettings({ params }: { params: Promise<{ slug?: string[] }> }) {
  const key = (await params).slug?.join('/') ?? '';
  const Page = PAGES[key as keyof typeof PAGES];
  if (Page) return <Page />;
  if (key.startsWith(UPDATE_RUN_PREFIX)) {
    const runId = key.slice(UPDATE_RUN_PREFIX.length);
    if (runId && !runId.includes('/')) {
      return <UpdateRunPage params={Promise.resolve({ runId })} />;
    }
  }
  notFound();
}
